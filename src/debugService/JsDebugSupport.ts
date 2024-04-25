import { Disposable } from "../utils/disposables";
import { IObservable, ITransaction, autorun, observableValue, transaction } from "../utils/observables/observable";
import { toDisposable } from "../utils/observables/observableInternal/lifecycle";
import { ErrorMessage } from "../utils/utils";
import { Binding, CdpClient } from "./CdpClient";
import { assumeType } from "../utils/Validator";
import { DebugSessionProxy } from "./DebugSessionService";
import { IProperty, IDebugSupport, PropertyInformation, IRequestHandler } from "./debugService";

export class JsDebugSupport extends Disposable implements IDebugSupport {
    private readonly _debugSessions = new Map<DebugSessionProxy, JsDebugSession>();

    private getDebugSession(debugSession: DebugSessionProxy): JsDebugSession | undefined {
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

    getRequestHandler(debugSession: DebugSessionProxy): IObservable<IRequestHandler | undefined> | undefined {
        const jsDebugSession = this.getDebugSession(debugSession);
        return jsDebugSession?.requestHandler;
    }
}

export class JsDebugSession extends Disposable {
    private readonly _references = new Set<JsProperty>();
    private readonly _writeUpdates = new Map<JsProperty, string>();
    private readonly _readUpdates = new Set<JsProperty>();

    private _cdpInitializationPromise: Promise<CdpClient | undefined> | undefined = undefined;

    private readonly _availableProperties = observableValue<PropertyInformation[]>(this, []);

    get availableProperties(): IObservable<PropertyInformation[]> { return this._availableProperties; }

    private readonly _requestHandler = observableValue<IRequestHandler | undefined>(this, undefined);
    get requestHandler(): IObservable<IRequestHandler | undefined> { return this._requestHandler; }

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


        interface GlobalObj {
            $$debugValueEditor_runListenerInstalled?: boolean;
            $$debugValueEditor_run?: (data: unknown) => void;
        }
        client.addBinding(runFunctionAvailableBinding, data => {
            this._requestHandler.set({
                sendRequest: async (requestData) => {
                    function sendRequest(data: unknown) {
                        const g = globalThis as any as GlobalObj;
                        if (g.$$debugValueEditor_run) {
                            return g.$$debugValueEditor_run(data);
                        } else {
                            throw new Error('run function is missing');
                        }
                    }
                    await this.debugSession.evaluate({
                        expression: `(${sendRequest.toString()})(${JSON.stringify(requestData)})`,
                        context: 'copy',
                        frameId: undefined,
                    });
                }
            }, undefined);
        }).then(async () => {
            function installPropertiesListener(runFunctionAvailableBindingFn: typeof runFunctionAvailableBinding.TFunctionValue) {
                const g = globalThis as any as GlobalObj;
                if (g.$$debugValueEditor_runListenerInstalled) {
                    return;
                }

                let existingRunFn = g.$$debugValueEditor_run;
                Object.defineProperty(g, '$$debugValueEditor_run', {
                    get() { return existingRunFn; },
                    set(value) {
                        existingRunFn = value;
                        runFunctionAvailableBindingFn({});
                    }
                });
                g.$$debugValueEditor_runListenerInstalled = true;

                if (existingRunFn) { runFunctionAvailableBindingFn({}); }
            }

            await this.debugSession.evaluate({
                expression: `(${installPropertiesListener.toString()})(${runFunctionAvailableBinding.getFunctionValue()});`,
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
    expression: string;
};

const updateAvailablePropertiesBinding = new Binding("$$debugValueEditor_updateAvailableProperties", assumeType<{ expressions: AvailablePropertyInfo[] }>());
const refreshBinding = new Binding('$$debugValueEditor_refresh', assumeType<{}>());
const runFunctionAvailableBinding = new Binding('$$debugValueEditor_runFunctionAvailable', assumeType<{}>());
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
