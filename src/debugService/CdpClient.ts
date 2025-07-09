import { Event, commands } from "vscode";
import { IDisposable } from "../utils/disposables";
import { WebSocket } from "ws";
import { JsDebugSession } from "./JsDebugSupport";
import { Validator } from "../utils/Validator";
import { toDisposable } from "../utils/observables/observableInternal/commonFacade/deps";
import { ProtocolMapping } from "devtools-protocol/types/protocol-mapping";

export class CdpClient implements IDisposable {
    public static async connectToSession(session: JsDebugSession): Promise<CdpClient | undefined> {
        let data: { host: string; port: number; path: string; } | undefined;

        for (let attempt = 0; attempt < 5; attempt++) {
            if (attempt > 0) {
                await new Promise(resolve => setTimeout(resolve, attempt >= 2 ? 3000 : 2000));
            }

            try {
                data = await commands.executeCommand(
                    'extension.js-debug.requestCDPProxy',
                    session.debugSession.session.id
                ) as { host: string; port: number; path: string; } | undefined;
            } catch (e) {
                console.warn(`Failed to get CDP proxy: ${e}`);
            }

            if (data) {
                break;
            }
        }

        if (!data) {
            console.error('Failed to get CDP proxy, giving up');
            return undefined;
        }

        const addr = `ws://${data.host}:${data.port}${data.path || ''}`;

        return await CdpClient.connectToAddress(addr, session);
    }

    public static async connectToAddress(address: string, source: object | undefined = undefined): Promise<CdpClient> {
        const webSocket = new WebSocket(address);
        await new Promise<void>((resolve) => {
            webSocket.on('open', async () => {
                resolve();
            });
        });
        return new CdpClient(webSocket, source);
    }

    private _lastMessageId = 0;
    private readonly _pendingRequests: Map<MessageId, {
        resolve: (result: unknown) => void;
        reject: (err: Error) => void;
    }> = new Map();
    private readonly _subscriptions: Map<string, SubscriptionCallback[]> = new Map();

    constructor(
        private readonly _ws: WebSocket,
        private readonly _source: object | undefined,
    ) {
        this._ws.on('message', (d) => {
            const message = d.toString();
            const json = JSON.parse(message);
            const response = json as ProtocolMessage;

            if (response.id === undefined) {
                const event = response as ICdpEvent;
                const callbacks = this._subscriptions.get(event.method) || [];
                for (const callback of callbacks) {
                    callback(event.params);
                }
            } else {
                const r = response as ICdpResponse;
                const pendingRequest = this._pendingRequests.get(r.id);
                if (!pendingRequest) {
                    return;
                }
                this._pendingRequests.delete(r.id);
                if ('error' in r) {
                    pendingRequest.reject(new Error(JSON.stringify(r.error)));
                } else if ('result' in r) {
                    pendingRequest.resolve(r.result);
                }
            }
        });

        const log = false;

        if (log) {
            this._ws.on('open', () => {
                console.log(`CdpClient.onOpen: ${this}`);
            });
            this._ws.on('close', () => {
                console.log(`CdpClient.onClose: ${this}`);
            });
            this._ws.on('error', (err) => {
                console.error(`CdpClient.error: ${this}`, err);
            });

            console.log(`CdpClient.constructor: ${this}`);
        }

    }

    toString() {
        return `CdpClient(${this._source})`;
    }

    dispose(): void {
        this._ws.close();
    }

    private readonly _onBindingCalled: Event<{ name: string; payload: string; }> = listener => {
        return this.subscribe('Runtime.bindingCalled', (data) => {
            listener({ name: data.name, payload: data.payload });
        });
    };

    public async addBinding(bindingName: string, onBindingCalled: (data: string) => void): Promise<IDisposable>;
    public async addBinding<T>(binding: Binding<string, T>, onBindingCalled: (data: T) => void): Promise<IDisposable>;
    public async addBinding(bindingName: string | Binding<string, any>, onBindingCalled: (data: string | any) => void): Promise<IDisposable> {
        if (bindingName instanceof Binding) {
            const binding = bindingName;
            bindingName = binding.name;
            const callback = onBindingCalled;
            onBindingCalled = dataStr => {
                let data;
                try {
                    data = JSON.parse(dataStr);
                } catch (e) {
                    console.error(`Could not parse JSON data received for binding ${bindingName}: ${JSON.stringify(dataStr)}`);
                    data = undefined;
                }
                if (!binding.validator(data)) {
                    console.error(`Invalid data received for binding ${bindingName}: ${JSON.stringify(data, undefined, 4)}`);
                }
                callback(data);
            }
        }

        await this.request('Runtime.addBinding', { name: bindingName });
        const d = this._onBindingCalled(e => {
            if (e.name === bindingName) {
                onBindingCalled(e.payload);
            }
        });
        return {
            dispose: () => {
                d.dispose();
                this.request('Runtime.removeBinding', { name: bindingName });
            }
        };
    }

    public subscribe<TMethod extends keyof ProtocolMapping.Events>(method: TMethod, callback: SubscriptionCallback<ProtocolMapping.Events[TMethod][0]>): IDisposable {
        const domainAndEvent = method;

        let subscriptions = this._subscriptions.get(domainAndEvent);
        if (!subscriptions) {
            subscriptions = [];
            this._subscriptions.set(domainAndEvent, subscriptions);
        }
        subscriptions.push(callback);
        if (subscriptions.length === 1) {
            this.requestUntyped('JsDebug', 'subscribe', { events: [domainAndEvent] }).catch(e => {
                console.error(`Failed to subscribe to ${domainAndEvent} events: ${e}`);
            });
        }

        return toDisposable(() => {
            const callbacks = this._subscriptions.get(domainAndEvent);
            if (!callbacks) {
                return;
            }

            const index = callbacks.indexOf(callback);
            if (index !== -1) {
                callbacks.splice(index, 1);
            }
        });
    }

    public async requestUntyped(domain: string, method: string, params?: Record<string, unknown>): Promise<unknown> {
        return await this._send(`${domain}.${method}`, params);
    }

    public async request<TMethod extends keyof ProtocolMapping.Commands>(method: TMethod, ...params: ProtocolMapping.Commands[TMethod]['paramsType']): Promise<ProtocolMapping.Commands[TMethod]['returnType']> {
        const result = await this._send(method, (params as any)[0]);
        return result as any;
    }

    private async _send(method: string, params?: Record<string, unknown>): Promise<unknown> {
        const messageId = ++this._lastMessageId;
        return new Promise((resolve, reject) => {
            this._pendingRequests.set(messageId, { resolve, reject, });

            const message = { id: messageId, method, params, };
            const json = JSON.stringify(message);
            this._ws.send(json);
        });
    }
}

export class Binding<TName extends string, T> {
    private readonly T: T = undefined!;

    public readonly TRuntimeGlobalThis: { [TKey in TName]: (jsonData: string) => void } = undefined!;

    constructor(
        public readonly name: TName,
        public readonly validator: Validator<T>,
    ) { }

    public getFunctionValue(): string {
        return `function (data) { globalThis[${JSON.stringify(this.name)}](JSON.stringify(data)); }`;
    }

    public getFunctionValueS(): () => string {
        return () => this.getFunctionValue();
    }

    public readonly TFunctionValue: (data: T) => void = undefined!;
}

type SubscriptionCallback<T = any> = (data: T) => void;
type MessageId = number;
type ProtocolMessage = ICdpEvent | ICdpResponse;
type ICdpResponse = ICdpErrorResponse | ICdpSuccessResponse;
interface ICdpEvent {
    id?: MessageId;
    method: string;
    params: Record<string, unknown>;
    sessionId?: string;
}
interface ICdpErrorResponse {
    id: MessageId;
    method?: string;
    error: { code: number; message: string; };
    sessionId?: string;
}
interface ICdpSuccessResponse {
    id: MessageId;
    result: Record<string, unknown>;
    sessionId?: string;
}
