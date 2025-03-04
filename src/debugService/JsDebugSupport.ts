import { Disposable, DisposableStore, IDisposable } from "../utils/disposables";
import { IObservable, ITransaction, autorun, constObservable, derived, observableValue, transaction } from "../utils/observables/observable";
import { ErrorMessage } from "../utils/utils";
import { Binding, CdpClient } from "./CdpClient";
import { assumeType } from "../utils/Validator";
import { DebugSessionProxy } from "./DebugSessionService";
import { IProperty, IDebugSupport, PropertyInformation, IDebugChannel } from "./IDebugSupport";
import { EventEmitter } from "vscode";
import { toDisposable } from "../utils/observables/observableInternal/commonFacade/deps";

export class JsDebugSupport extends Disposable implements IDebugSupport {
    private readonly _debugSessions = new Map<DebugSessionProxy, JsDebugSession>();

    public getDebugSession(debugSession: DebugSessionProxy): JsDebugSession | undefined {
        // https://github.com/microsoft/vscode-js-debug/blob/2152210dc7c3933e2b4ef7c72d72cf2fef765760/src/common/contributionUtils.ts#L65
        const supportedSessionTypes = [
            'pwa-extensionHost',
            'node-terminal',
            'pwa-node',
            'pwa-chrome',
            'pwa-msedge',
            'node',
            'chrome'
        ];

        if (!supportedSessionTypes.includes(debugSession.session.type)) {
            return undefined;
        }

        let jsDebugSession = this._debugSessions.get(debugSession);
        if (!jsDebugSession) {
            jsDebugSession = new JsDebugSession(debugSession);
            this._debugSessions.set(debugSession, jsDebugSession);
            debugSession.onDidTerminate(() => {
                jsDebugSession!.dispose();
                return this._debugSessions.delete(debugSession);
            });
        }

        return jsDebugSession;
    }

    getAvailableProperties(debugSession: DebugSessionProxy): IObservable<PropertyInformation[]> | undefined {
        const jsDebugSession = this.getDebugSession(debugSession);
        return jsDebugSession?.availableProperties;
    }

    createProperty(debugSession: DebugSessionProxy, expression: string, initialValue: string | undefined): IProperty | undefined {
        const jsDebugSession = this.getDebugSession(debugSession);
        if (!jsDebugSession) {
            return undefined;
        }
        return new JsProperty(jsDebugSession, expression, initialValue);
    }

    getAvailableChannels(debugSession: DebugSessionProxy): IObservable<readonly IDebugChannel[]> {
        const jsDebugSession = this.getDebugSession(debugSession);
        return jsDebugSession?.availableDebugChannels ?? constObservable([]);
    }

    getChannel(debugSession: DebugSessionProxy, channelId: string): IObservable<IDebugChannel | undefined> {
        const c = this.getAvailableChannels(debugSession);
        return derived(reader => c.read(reader).find(c => c.channelId === channelId));
    }

    override dispose(): void {
        for (const jsDebugSession of this._debugSessions.values()) {
            jsDebugSession.dispose();
        }
        this._debugSessions.clear();
        super.dispose();
    }
}

export class JsDebugSession extends Disposable {
    private readonly _references = new Set<JsProperty>();
    private readonly _writeUpdates = new Map<JsProperty, string>();
    private readonly _readUpdates = new Set<JsProperty>();

    private _cdpInitializationPromise: Promise<CdpClient | undefined> | undefined = undefined;

    private readonly _availableProperties = observableValue<PropertyInformation[]>(this, []);

    get availableProperties(): IObservable<PropertyInformation[]> { return this._availableProperties; }

    private readonly _availableDebugChannels = observableValue<IObservable<readonly IDebugChannel[]> | undefined>(this, undefined);
    public readonly availableDebugChannels: IObservable<readonly IDebugChannel[]> = derived(this, reader => {
        return this._availableDebugChannels.read(reader)?.read(reader) ?? [];
    });

    constructor(
        public readonly debugSession: DebugSessionProxy
    ) {
        super();

        this._register(autorun(reader => {
            const pausedStackFrameId = debugSession.pausedStackFrameId.read(reader);

            for (const r of this._references) {
                this._scheduleReadUpdate(r);
            }
            this._update(pausedStackFrameId);
        }));

        this.checkCdp().catch(e => {
            console.warn('Error while initializing CDP', e);
        });
    }

    public getCdpClient(): Promise<CdpClient | undefined> {
        this.checkCdp().catch(e => {
            console.warn('Error while initializing CDP', e);
        });
        return this._cdpInitializationPromise!;
    }

    private async checkCdp(): Promise<void> {
        const client = await this._cdpInitializationPromise;
        if (!client) {
            this._cdpInitializationPromise = this._initCdpProxy();
            await this._cdpInitializationPromise;
        }
    }

    private async _initCdpProxy(): Promise<CdpClient | undefined> {
        const client = await CdpClient.connectToSession(this);
        if (!client) { return undefined; }
        this._registerOrDispose(client);

        const evaluator = new CdpEvaluator(client);

        await Promise.all([
            client.addBinding(promiseResolvedBinding, payload => {
                const prop = [...this._references].find(p => p.expression === payload.expression);
                if (!prop) {
                    return;
                }
                transaction(tx => {
                    /** @description End update (async) */
                    this.updateProperty(prop, payload.result, tx);
                });
            }),
            client.addBinding(refreshBinding, _data => {
                this._references.forEach(r => this._scheduleReadUpdate(r));
                this._update(this.debugSession.pausedStackFrameId.get());
            }),
            client.addBinding(updateAvailablePropertiesBinding, payload => {
                this._availableProperties.set(payload.expressions.map(e => PropertyInformation.from(e, this.debugSession)), undefined);
            }).then(async () => {
                type GlobalThisObj = {
                    $$debugValueEditor_propertiesListenerInstalled?: boolean;
                    $$debugValueEditor_properties: AvailablePropertyInfo[];
                };

                await evaluator.evaluate(
                    function (updateAvailablePropertiesFn: typeof updateAvailablePropertiesBinding.TFunctionValue) {
                        const g = globalThis as any as GlobalThisObj;
                        if (g.$$debugValueEditor_propertiesListenerInstalled) {
                            return;
                        }
                        let properties = g.$$debugValueEditor_properties;
                        if (properties) {
                            updateAvailablePropertiesFn({ expressions: properties });
                        }

                        Object.defineProperty(g, '$$debugValueEditor_properties', {
                            get() { return properties; },
                            set(value: AvailablePropertyInfo[]) {
                                properties = value;
                                updateAvailablePropertiesFn({ expressions: value });
                            }
                        });
                        g.$$debugValueEditor_propertiesListenerInstalled = true;
                    },
                    updateAvailablePropertiesBinding.getFunctionValueS()
                );
            })
        ]);

        const result = await createDebugChannelFeature(client, this.debugSession);
        this._register(result);
        this._availableDebugChannels.set(result.channels, undefined);

        return client;
    }

    private _scheduleReadUpdate(prop: JsProperty): void {
        this._readUpdates.add(prop);
    }

    private _scheduleWriteUpdate(prop: JsProperty, newValue: string): void {
        this._writeUpdates.set(prop, newValue);
    }

    private async _update(stackFrame: number | undefined): Promise<void> {
        if (this._readUpdates.size === 0 && this._writeUpdates.size === 0) {
            return;
        }

        const referencesToWrite = [...this._writeUpdates].map(([ref, newValue]) => ({ ref, newValue }));
        // Don't read the write-refs
        const referencesToRead = [...this._readUpdates].filter(r => !this._writeUpdates.has(r));

        transaction(tx => {
            /** @description Start update */
            for (const r of referencesToRead) {
                r.state.set(r.didUpdate ? 'initializing' : 'updating', tx);
                r.value.set(undefined, tx);
            }
            for (const w of referencesToWrite) {
                w.ref.value.set(w.newValue, tx);
            }
        });

        await this._cdpInitializationPromise;

        const tryEvalImpl = function tryEvalImpl(fn: () => unknown, expression: string, promiseResolvedBindingFn: typeof promiseResolvedBinding.TFunctionValue): EvaluationResult {
            const g = (globalThis as { $$vscodeDebugValueEditor?: { cancellationCallbacksByExpr: Map<string, () => void> } });
            if (!g.$$vscodeDebugValueEditor) {
                g.$$vscodeDebugValueEditor = { cancellationCallbacksByExpr: new Map() };
            }

            const existingCancellationCallback = g.$$vscodeDebugValueEditor.cancellationCallbacksByExpr.get(expression);
            if (existingCancellationCallback) {
                g.$$vscodeDebugValueEditor.cancellationCallbacksByExpr.delete(expression);
                existingCancellationCallback();
            }

            try {
                let data = fn();
                let fileExtension: string | undefined = undefined;
                if (typeof data === 'object' && data) {
                    if ('$fileExtension' in data) {
                        fileExtension = data.$fileExtension as any;
                        data = { ...data };
                        delete (data as any).$fileExtension;
                    } else if (typeof (data as any).then === 'function') {
                        const dataAsPromise = data as Promise<unknown>;
                        let cancelled = false;
                        g.$$vscodeDebugValueEditor.cancellationCallbacksByExpr.set(expression, () => {
                            cancelled = true;
                        });
                        function handlePromiseResult(fn: () => unknown) {
                            if (cancelled) { return; }

                            try {
                                promiseResolvedBindingFn({
                                    expression,
                                    result: tryEvalImpl(fn, expression, promiseResolvedBindingFn),
                                });
                            } catch (e) {
                                console.error('unexpected error while sending notification for resolved promise', e);
                            }
                        }
                        dataAsPromise.then(
                            data => handlePromiseResult(() => data),
                            err => handlePromiseResult(() => { throw err; })
                        );
                        return { kind: 'updating' };
                    }
                }
                return { kind: 'ok', value: data, fileExtension };
            } catch (e) {
                return { kind: 'error', error: "" + e };
            }
        }

        function transformValue(newValue: string, expression: string, getExprValue: () => unknown, variableType: JsProperty['valueType']) {
            if (variableType === undefined) {
                try {
                    const v = getExprValue();
                    if (typeof v === 'string') {
                        variableType = 'string';
                    } else {
                        variableType = 'json';
                    }
                } catch (e) {
                    // ignore
                    variableType = 'json';
                }
            }
            if (variableType === 'string') {
                return newValue;
            } else if (variableType === 'json') {
                try {
                    return JSON.parse(newValue);
                } catch (e) {
                    throw new Error(`Could not parse new json value for expression "${expression}"`);
                }
            }
        }

        const expr = `
        (() => {
            ${tryEvalImpl.toString()}
            function tryEval(fn, expression) {
                return tryEvalImpl(fn, expression, ${promiseResolvedBinding.getFunctionValue()});
            }
            
            ${transformValue.toString()}
            ${referencesToWrite.map(w => `
            ${w.ref.expression} = transformValue(${JSON.stringify(w.newValue)}, ${JSON.stringify(w.ref.expression)}, () => ${w.ref.expression}, ${JSON.stringify(w.ref.valueType)});
        `).join('\n')}

            const values = [${referencesToRead.map(r => {
            return `tryEval(() => ${r.expression}, ${JSON.stringify(r.expression)})`;
        }).join(', ')}];

            return JSON.stringify(values);
        })()
        `;

        try {
            const result = await this.debugSession.evaluate({
                expression: expr,
                context: 'copy',
                frameId: stackFrame,
            });

            // Only clear after successful evaluation. TODO: Consider per-entry errors!
            this._readUpdates.clear();
            this._writeUpdates.clear();

            const data = JSON.parse(result.result) as EvaluationResult[];

            // Something to think about: the actual value might be different from the set value!
            // But ignoring the actual set value might be the right thing to do (to prevent flickering and weird endless-loops).
            transaction(tx => {
                /** @description Finish update */
                for (let i = 0; i < referencesToRead.length; i++) {
                    const ref = referencesToRead[i];
                    const res = data[i];
                    this.updateProperty(ref, res, tx);
                }
            });
        } catch (e) {
            console.error('Error while evaluating expression', e);
            ErrorMessage.showIfError(new ErrorMessage('Error while evaluating expression: ' + e));

            this._writeUpdates.clear();
        }
    }

    private updateProperty(ref: JsProperty, res: EvaluationResult, tx: ITransaction): void {
        switch (res.kind) {
            case 'error':
                ref.state.set('error', tx);
                ref.error.set(res.error, tx);
                ref.value.set(undefined, tx);
                return;

            case 'ok':
                ref.state.set('upToDate', tx);
                if (ref.valueType === undefined) {
                    if (typeof res.value === 'string') {
                        ref.valueType = 'string';
                    } else {
                        ref.valueType = 'json';
                    }
                }

                let value: string;
                if (ref.valueType === 'json') {
                    value = JSON.stringify(res.value);
                } else {
                    value = res.value + '';
                }

                ref.value.set(value, tx);
                ref.error.set(undefined, tx);
                ref.fileExtension.set(res.fileExtension, tx);
                return;

            case 'updating':
                ref.state.set('updating', tx);
                ref.value.set(undefined, tx);
                ref.error.set(undefined, tx);
                return;
        }
    }

    public async refresh(reference: JsProperty): Promise<void> {
        this._scheduleReadUpdate(reference);
        await this._update(this.debugSession.pausedStackFrameId.get());
    }

    public async setValue(reference: JsProperty, newValue: string): Promise<void> {
        this._scheduleWriteUpdate(reference, newValue);
        for (const r of this._references) {
            this._scheduleReadUpdate(r);
        }
        await this._update(this.debugSession.pausedStackFrameId.get());
    }

    public addReference(reference: JsProperty, initialValue: string | undefined): void {
        if (initialValue !== undefined) {
            this._scheduleWriteUpdate(reference, initialValue);
            for (const r of this._references) {
                this._scheduleReadUpdate(r);
            }
        } else {
            this._scheduleReadUpdate(reference);
        }
        this._references.add(reference);
        this._update(this.debugSession.pausedStackFrameId.get());
    }

    public removeReference(reference: JsProperty): void {
        this._references.delete(reference);
        this._readUpdates.delete(reference);
        this._writeUpdates.delete(reference);
    }

    public toString() {
        return `JsDebugSupport(${this.debugSession.session.name})`;
    }
}

class CdpEvaluator {
    constructor(
        private readonly _cdpClient: CdpClient,
    ) {
    }

    async evaluate<TArgs extends any[], TResult>(selfContainedFn: (...args: TArgs) => TResult, ...args: TArgs): Promise<TResult> {
        function serializeArg(arg: any) {
            if (typeof arg === 'function') {
                return arg();
            }
            return JSON.stringify(arg);
        }

        const result = await this._cdpClient.request('Runtime.evaluate', {
            expression: `(() => {
                try {
                    const result = (${selfContainedFn.toString()})(${args.map(a => serializeArg(a)).join(', ')});
                    return { kind: 'ok', value: result };
                } catch (e) {
                    return { kind: 'error', error: "" + e };
                }
            })()`,
            returnByValue: true,
        });

        const data = result.result.value as { kind: 'ok'; value: unknown } | { kind: 'error'; error: string; };

        if (data.kind === 'error') {
            throw new Error(data.error);
        }
        return data.value as TResult;
    }
}

class DebugSessionEvaluator {
    constructor(
        private readonly _session: DebugSessionProxy,
    ) { }

    async evaluate<TArgs extends any[], TResult>(selfContainedFn: (...args: TArgs) => TResult, ...args: TArgs): Promise<TResult> {
        function serializeArg(arg: any) {
            if (typeof arg === 'function') {
                return arg();
            }
            return JSON.stringify(arg);
        }

        const result = await this._session.evaluate({
            expression: `(() => {
                try {
                    const result = (${selfContainedFn.toString()})(${args.map(a => serializeArg(a)).join(', ')});
                    return JSON.stringify({ kind: 'ok', value: result });
                } catch (e) {
                    return JSON.stringify({ kind: 'error', error: "" + e });
                }
            })()`,
            frameId: undefined,
            context: 'repl',
        });

        const data = JSON.parse(result.result) as { kind: 'ok'; value: unknown } | { kind: 'error'; error: string; };

        if (data.kind === 'error') {
            throw new Error(data.error);
        }
        return data.value as TResult;
    }
}

type GlobalObj = {
    $$debugValueEditor_runtime: {
        debugChannelInstances: Map<string, { handleRequest: (data: unknown) => unknown }>;
        debugChannelsCtors: IDebugValueEditorGlobals['$$debugValueEditor_debugChannels']
    } | undefined;
} & IDebugValueEditorGlobals;

async function createDebugChannelFeature(client: CdpClient, debugSession: DebugSessionProxy): Promise<{ channels: IObservable<readonly IDebugChannel[]> } & IDisposable> {
    const availableDebugChannels = observableValue<readonly IDebugChannel[]>('availableDebugChannels', []);

    const notificationHandlers = new Map</* channelInstanceId */ string, EventEmitter<{ notificationData: unknown }>>();

    const store = new DisposableStore();

    store.add(await client.addBinding(debugChannelSendNotificationBinding, data => {
        const handler = notificationHandlers.get(data.channelInstanceId);
        if (handler) {
            handler.fire({ notificationData: data.notificationData });
        } else {
            console.error(`No handler found for channel "${data.channelInstanceId}"`, data);
        }
    }));

    const evaluator = new CdpEvaluator(client);

    async function installRuntime() {
        await evaluator.evaluate(
            function (debugChannelRegisterBindingFn: typeof debugChannelRegisterBinding.TFunctionValue) {
                const g = globalThis as any as GlobalObj;
                if (!g.$$debugValueEditor_runtime) {
                    const existingChannels = g.$$debugValueEditor_debugChannels ?? {};
                    const proxied = new Proxy({}, {
                        get: (target, key: string) => {
                            return existingChannels[key];
                        },
                        set: (target, key: string, value: any) => {
                            existingChannels[key] = value;
                            debugChannelRegisterBindingFn({ channelIds: [key] });
                            return true;
                        },
                    });
                    Object.defineProperty(g, '$$debugValueEditor_debugChannels', {
                        get() { return proxied; },
                        set(value) {
                            console.error('setting $$debugValueEditor_debugChannels after initialization is not supported');
                        }
                    });
                    g.$$debugValueEditor_runtime = {
                        debugChannelInstances: new Map(),
                        debugChannelsCtors: existingChannels,
                    };
                }

                const keys = Object.keys(g.$$debugValueEditor_runtime.debugChannelsCtors);
                if (keys.length > 0) {
                    debugChannelRegisterBindingFn({ channelIds: keys });
                }
            },
            debugChannelRegisterBinding.getFunctionValueS()
        );
    }

    store.add(await client.addBinding(debugChannelRegisterBinding, data => {
        const newChannels: IDebugChannel[] = [];
        for (const channelId of data.channelIds) {
            const onNotificationEmitter = new EventEmitter<{ notificationData: unknown }>();
            const newChannel = new DebugChannel(client, channelId, onNotificationEmitter);
            notificationHandlers.set(newChannel.channelInstanceId, onNotificationEmitter);
            newChannels.push(newChannel);
        }

        const existing = availableDebugChannels.get();
        availableDebugChannels.set([...existing, ...newChannels], undefined);
    }));

    await installRuntime();

    store.add(client.subscribe('Runtime.executionContextsCleared', () => {
        availableDebugChannels.set([], undefined);
        installRuntime().catch(e => {
            console.error('Error while installing runtime', e);
        });
    }));

    return {
        channels: availableDebugChannels,
        dispose() {
            store.dispose();
        }
    }
}

class DebugChannel implements IDebugChannel {
    public static _instanceCounter = 0;
    public readonly channelInstanceId = `${this.channelId}${DebugChannel._instanceCounter++}_${new Date().getTime()}`;

    private readonly _evaluator = new CdpEvaluator(this._client);

    constructor(
        private readonly _client: CdpClient,
        public readonly channelId: string,
        private readonly _onNotificationEmitter: EventEmitter<{ notificationData: unknown }>
    ) { }

    toString() {
        return `DebugChannel@${this.channelInstanceId}`;
    }

    public readonly onNotification = this._onNotificationEmitter.event;

    async listenForNotifications() {
        await this._evaluator.evaluate(
            function connect(channelId: string, channelInstanceId: string, debugChannelSendNotificationBindingFn: typeof debugChannelSendNotificationBinding.TFunctionValue) {
                const g = globalThis as any as GlobalObj;
                const handler = g.$$debugValueEditor_debugChannels?.[channelId];
                if (handler) {
                    const h = handler({
                        sendNotification(data) {
                            debugChannelSendNotificationBindingFn({ channelInstanceId, notificationData: data })
                        },
                    });
                    g.$$debugValueEditor_runtime!.debugChannelInstances.set(channelInstanceId, h);
                } else {
                    throw new Error('handler is missing');
                }
            },
            this.channelId,
            this.channelInstanceId,
            debugChannelSendNotificationBinding.getFunctionValueS(),
        );
    }

    async sendRequest(requestData: unknown) {
        function sendRequest(channelInstanceId: string, data: unknown) {
            const g = globalThis as any as GlobalObj;
            const handler = g.$$debugValueEditor_runtime?.debugChannelInstances.get(channelInstanceId);
            if (handler) {
                return handler.handleRequest(data);
            } else {
                throw new Error(`channel instance ${channelInstanceId} is missing`);
            }
        }

        const result = await this._evaluator.evaluate(sendRequest, this.channelInstanceId, requestData);
        return result;
    }
}

export type AvailablePropertyInfo = string | {
    label: string;
    expression?: string;
};

const debugChannelRegisterBinding = new Binding('$$debugValueEditor_registerDebugChannel', assumeType<{ channelIds: string[] }>());
const debugChannelSendNotificationBinding = new Binding('$$debugValueEditor_debugChannelNotification', assumeType<{ channelInstanceId: string, notificationData: unknown }>());

const updateAvailablePropertiesBinding = new Binding("$$debugValueEditor_updateAvailableProperties", assumeType<{ expressions: AvailablePropertyInfo[] }>());
const refreshBinding = new Binding('$$debugValueEditor_refresh', assumeType<{}>());
const promiseResolvedBinding = new Binding('$$debugValueEditor_promiseResolved', assumeType<{
    expression: string;
    result: EvaluationResult;
}>());

type EvaluationResult = { kind: 'ok'; value: unknown; fileExtension?: string } | { kind: 'error'; error: string; } | { kind: 'updating' };

export class JsProperty extends Disposable implements IProperty {
    public didUpdate = false;

    public readonly value = observableValue<string | undefined>(this, undefined);
    public readonly fileExtension = observableValue<string | undefined>(this, undefined);
    public readonly error = observableValue<string | undefined>(this, undefined);
    public readonly state = observableValue<'initializing' | 'upToDate' | 'updating' | 'error'>(this, 'initializing');

    public valueType: 'string' | 'json' | undefined = undefined;

    constructor(
        public readonly debugSession: JsDebugSession,
        public readonly expression: string,
        initialValue: string | undefined,
    ) {
        super();

        debugSession.addReference(this, initialValue);
        this._register(toDisposable(() => {
            debugSession.removeReference(this);
        }));
    }

    setValue(newValue: string): Promise<void> {
        return this.debugSession.setValue(this, newValue);
    }

    refresh(): void {
        this.debugSession.refresh(this);
    }
}

export interface IDebugValueEditorGlobals {
    $$debugValueEditor_run: (args: any) => void;
    $$debugValueEditor_properties: readonly any[];

    $$debugValueEditor_debugChannels: Record</* name of the debug channel */ string, DebugChannelCtor>;

    $$debugValueEditor_refresh?: (body: string) => void;
}

type DebugChannelCtor = (host: IHost) => IRequestHandler;

interface IHost {
    sendNotification: (data: unknown) => void;
}

interface IRequestHandler {
    handleRequest: (data: unknown) => unknown;
}
