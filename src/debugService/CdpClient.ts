import { Event, commands } from "vscode";
import { IDisposable } from "../utils/disposables";
import { toDisposable } from "../utils/observables/observableInternal/lifecycle";
import { WebSocket } from "ws";
import { JsDebugSession } from "./JsDebugSupport";
import { Validator } from "../utils/Validator";

export class CdpClient implements IDisposable {
    public static async connectToSession(session: JsDebugSession): Promise<CdpClient | undefined> {
        const data = await commands.executeCommand(
            'extension.js-debug.requestCDPProxy',
            session.debugSession.session.id
        ) as { host: string; port: number; path: string; } | undefined;

        if (!data) {
            return undefined;
        }

        const addr = `ws://${data.host}:${data.port}${data.path || ''}`;

        return await CdpClient.connectToAddress(addr);
    }

    public static async connectToAddress(address: string): Promise<CdpClient> {
        const webSocket = new WebSocket(address);
        await new Promise<void>((resolve) => {
            webSocket.on('open', async () => {
                resolve();
            });
        });
        return new CdpClient(webSocket);
    }

    private _lastMessageId = 0;
    private readonly _pendingRequests: Map<MessageId, {
        resolve: (result: unknown) => void;
        reject: (err: Error) => void;
    }> = new Map();
    private readonly _subscriptions: Map<string, SubscriptionCallback[]> = new Map();

    constructor(private readonly _ws: WebSocket) {
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
    }

    dispose(): void {
        this._ws.close();
    }

    private readonly _onBindingCalled: Event<{ name: string; payload: string; }> = listener => {
        return this._subscribe('Runtime', 'bindingCalled', (data) => {
            listener({ name: data.name as string, payload: data.payload as string });
        });
    };

    public async addBinding(bindingName: string, onBindingCalled: (data: string) => void): Promise<void>;
    public async addBinding<T>(binding: Binding<string, T>, onBindingCalled: (data: T) => void): Promise<void>;
    public async addBinding(bindingName: string | Binding<string, any>, onBindingCalled: (data: string | any) => void): Promise<void> {
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

        await this._request('Runtime', 'addBinding', { name: bindingName });
        this._onBindingCalled(e => {
            if (e.name === bindingName) {
                onBindingCalled(e.payload);
            }
        });
    }

    private _subscribe(domain: string, event: string, callback: SubscriptionCallback): IDisposable {
        const domainAndEvent = `${domain}.${event}`;

        if (this._subscriptions.has(domainAndEvent)) {
            this._subscriptions.get(domainAndEvent)?.push(callback);
        } else {
            this._subscriptions.set(domainAndEvent, [callback]);
        }

        this._request('JsDebug', 'subscribe', { events: [`${domain}.${event}`] });

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

    private async _request(domain: string, method: string, params?: Record<string, unknown>): Promise<unknown> {
        return await this._send(`${domain}.${method}`, params);
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
        return `function (data) { globalThis.${this.name}(JSON.stringify(data)); }`;
    }

    public readonly TFunctionValue: (data: T) => void = undefined!;
}

type SubscriptionCallback = (data: Record<string, unknown>) => void;
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
