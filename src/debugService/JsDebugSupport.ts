import { Disposable } from "../utils/disposables";
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
}

export class JsDebugSession extends Disposable {
    private readonly _references = new Set<JsProperty>();
    private readonly _writeUpdates = new Map<JsProperty, string>();
    private readonly _readUpdates = new Set<JsProperty>();

    private _cdpInitializationPromise: Promise<CdpClient | undefined> | undefined = undefined;

    private readonly _availableProperties = observableValue<PropertyInformation[]>(this, []);

    get availableProperties(): IObservable<PropertyInformation[]> { return this._availableProperties; }

    private readonly _availableDebugChannels = observableValue<readonly IDebugChannel[]>(this, []);
    get availableDebugChannels(): IObservable<readonly IDebugChannel[]> { return this._availableDebugChannels; }

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

        this.checkCdp();
    }

    public getCdpClient(): Promise<CdpClient | undefined> {
        this.checkCdp();
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
            })
        ]);

        client.addBinding(updateAvailablePropertiesBinding, payload => {
            this._availableProperties.set(payload.expressions.map(e => PropertyInformation.from(e, this.debugSession)), undefined);
        }).then(async () => {
            type GlobalThisObj = {
                $$debugValueEditor_propertiesListenerInstalled?: boolean;
                $$debugValueEditor_properties: AvailablePropertyInfo[];
            };

            function installPropertiesListener(updateAvailablePropertiesFn: typeof updateAvailablePropertiesBinding.TFunctionValue) {
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
            }

            await this.debugSession.evaluate({
                expression: `(${installPropertiesListener.toString()})(${updateAvailablePropertiesBinding.getFunctionValue()});`,
                frameId: undefined,
                context: 'repl',
            });
        });

        const notificationHandlers = new Map</* channelId */ string, EventEmitter<{ notificationData: unknown }>>();

        interface GlobalObj {
            $$debugValueEditor_runtime: { debugChannels: Map<string, { handleRequest: (data: unknown) => unknown }> } | undefined;
            $$debugValueEditor_debugChannels: Record<string, (host: ({ sendNotification: (data: unknown) => void })) => { handleRequest: (data: unknown) => unknown }>;
        }

        client.addBinding(debugChannelSendNotificationBinding, data => {
            const handler = notificationHandlers.get(data.channelId);
            if (handler) {
                handler.fire({ notificationData: data.notificationData });
            } else {
                console.error(`No handler found for channel "${data.channelId}"`, data);
            }
        });

        client.addBinding(debugChannelRegisterBinding, data => {
            const newChannels: IDebugChannel[] = [];
            for (const channelId of data.channelIds) {
                const onNotificationEmitter = new EventEmitter<{ notificationData: unknown }>();
                notificationHandlers.set(channelId, onNotificationEmitter);
                const newChannel: IDebugChannel = {
                    channelId: channelId,
                    onNotification: onNotificationEmitter.event,
                    listenForNotifications: async () => {
                        function connect(channelId: string, debugChannelSendNotificationBindingFn: typeof debugChannelSendNotificationBinding.TFunctionValue) {
                            const g = globalThis as any as GlobalObj;

                            const handler = g.$$debugValueEditor_debugChannels?.[channelId];

                            if (handler) {
                                const h = handler({
                                    sendNotification(data) {
                                        debugChannelSendNotificationBindingFn({ channelId, notificationData: data })
                                    },
                                });
                                g.$$debugValueEditor_runtime!.debugChannels.set(channelId, h);
                            } else {
                                throw new Error('handler is missing');
                            }
                        }
                        await this.debugSession.evaluate({
                            expression: `(${connect.toString()})(${JSON.stringify(channelId)}, ${debugChannelSendNotificationBinding.getFunctionValue()})`,
                            context: 'copy',
                            frameId: undefined,
                        });
                    },
                    sendRequest: async (requestData) => {
                        function sendRequest(channelId: string, data: unknown) {
                            const g = globalThis as any as GlobalObj;

                            const handler = g.$$debugValueEditor_runtime?.debugChannels.get(channelId);

                            if (handler) {
                                return JSON.stringify(handler.handleRequest(data));
                            } else {
                                throw new Error(`handler ${channelId} is missing`);
                            }
                        }
                        const result = await this.debugSession.evaluate({
                            expression: `(${sendRequest.toString()})(${JSON.stringify(channelId)}, ${JSON.stringify(requestData)})`,
                            context: 'copy',
                            frameId: undefined,
                        });
                        if (!result) {
                            // TODO check if we should return an error instead of throwing
                            throw new Error('request handler function failed');
                        }
                        return JSON.parse(result.result);
                    }
                };
                newChannels.push(newChannel);
            }

            const existing = this._availableDebugChannels.get();
            this._availableDebugChannels.set([...existing, ...newChannels], undefined);
        }).then(async () => {
            function injectRuntime(debugChannelRegisterBindingFn: typeof debugChannelRegisterBinding.TFunctionValue) {
                const g = globalThis as any as GlobalObj;
                if (g.$$debugValueEditor_runtime) {
                    return;
                }

                const existingChannels = g.$$debugValueEditor_debugChannels ?? {};
                const proxied = new Proxy({}, {
                    get: (target, key: string) => {
                        return existingChannels[key];
                    },
                    set: (target, key: string, value: any) => {
                        existingChannels[key] = value;
                        debugChannelRegisterBindingFn({ channelIds: [key] });
                        return true;
                    }
                });
                Object.defineProperty(g, '$$debugValueEditor_debugChannels', {
                    get() { return proxied; },
                    set(value) {
                        console.error('setting $$debugValueEditor_debugChannels after initialization is not supported');
                    }
                });
                g.$$debugValueEditor_runtime = {
                    debugChannels: new Map()
                };
                const keys = Object.keys(existingChannels);
                if (keys.length > 0) {
                    debugChannelRegisterBindingFn({ channelIds: keys });
                }
            }

            await this.debugSession.evaluate({
                expression: `(${injectRuntime.toString()})(${debugChannelRegisterBinding.getFunctionValue()});`,
                frameId: undefined,
                context: 'repl',
            });
        });

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
}

export type AvailablePropertyInfo = string | {
    label: string;
    expression?: string;
};

const debugChannelRegisterBinding = new Binding('$$debugValueEditor_registerDebugChannel', assumeType<{ channelIds: string[] }>());
const debugChannelSendNotificationBinding = new Binding('$$debugValueEditor_debugChannelNotification', assumeType<{ channelId: string, notificationData: unknown }>());

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
