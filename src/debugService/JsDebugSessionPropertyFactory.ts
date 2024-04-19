import { Disposable } from "../utils/disposables";
import { ITransaction, autorun, observableValue, transaction } from "../utils/observables/observable";
import { toDisposable } from "../utils/observables/observableInternal/lifecycle";
import { CdpClient } from "./CdpClient";
import { DebugSessionProxy } from "./DebugSessionService";
import { IProperty, IPropertyFactory } from "./debugService";

export class JsDebugSessionPropertyFactory extends Disposable implements IPropertyFactory {
    private readonly _debugSessions = new Map<DebugSessionProxy, JsDebugSession>();

    createProperty(debugSession: DebugSessionProxy, expression: string, initialValue: string | undefined): IProperty | undefined {
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

        return new JsProperty(jsDebugSession, expression, initialValue);
    }
}

export class JsDebugSession extends Disposable {
    private readonly _references = new Set<JsProperty>();
    private readonly _writeUpdates = new Map<JsProperty, string>();
    private readonly _readUpdates = new Set<JsProperty>();

    private _cdpInitializationPromise: Promise<CdpClient | undefined> | undefined = undefined;

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

        await client.addBinding(promiseResolvedBindingName, data => {
            const payload = JSON.parse(data) as PromiseResolvedBindingNamePayload;
            const prop = [...this._references].find(p => p.expression === payload.expression);
            if (!prop) {
                return;
            }
            transaction(tx => {
                this.updateProperty(prop, payload.result, tx);
            });
        });
        await client.addBinding(refreshBindingName, data => {
            this._references.forEach(r => this._scheduleReadUpdate(r));
            this._update(this.debugSession.pausedStackFrameId.get());
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
            for (const r of referencesToRead) {
                r.state.set(r.didUpdate ? 'initializing' : 'updating', tx);
                r.value.set(undefined, tx);
            }
            for (const w of referencesToWrite) {
                w.ref.value.set(w.newValue, tx);
            }
        });

        await this._cdpInitializationPromise;

        const tryEvalImpl = function tryEvalImpl(fn: () => unknown, expression: string, promiseResolvedBinding: (data: PromiseResolvedBindingNamePayload) => void): EvaluationResult {
            try {
                let data = fn();
                let fileExtension: string | undefined = undefined;
                if (typeof data === 'object' && data) {
                    if ('$fileExtension' in data) {
                        fileExtension = data.$fileExtension as any;
                        data = { ...data };
                        delete (data as any).$fileExtension;
                    } else if ('then' in data && data.then === 'function') {
                        const p = data as Promise<unknown>;
                        function handlePromiseResult(fn: () => unknown) {
                            try {
                                promiseResolvedBinding({
                                    expression,
                                    result: tryEvalImpl(fn, expression, promiseResolvedBinding),
                                });
                            } catch (e) {
                                console.error('unexpected error while sending notification for resolved promise', e);
                            }
                        }
                        p.then(
                            data => handlePromiseResult(() => data),
                            err => handlePromiseResult(() => { throw err; })
                        );
                        return { updating: "Promise is resolving" };
                    }
                }
                return { value: data, fileExtension };
            } catch (e) {
                return { error: "" + e };
            }
        }

        const expr = `
        (() => {
            ${tryEvalImpl.toString()}
            function tryEval(fn, expression) {
                tryEvalImpl(fn, expression, arg => ${promiseResolvedBindingName}(JSON.stringify(arg)))
            }
            ${referencesToWrite.map(w => `
            ${w.ref.expression} = ${JSON.stringify(JSON.parse(w.newValue))};
        `).join('\n')}

            const values = [${referencesToRead.map(r => {
            return `tryEval(() => ${r.expression}, ${JSON.stringify(r.expression)})`;
        }).join(', ')}];

            return JSON.stringify(values);
        })()
        `;

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
            for (let i = 0; i < referencesToRead.length; i++) {
                const ref = referencesToRead[i];
                const res = data[i];
                this.updateProperty(ref, res, tx);
            }
        });
    }

    private updateProperty(ref: JsProperty, res: EvaluationResult, tx: ITransaction): void {
        if ('error' in res) {
            ref.state.set('error', tx);
            ref.error.set(res.error, tx);
            ref.value.set(undefined, tx);
        } else if ('value' in res) {
            ref.state.set('upToDate', tx);
            ref.value.set(JSON.stringify(res.value, undefined, 4), tx);
            ref.error.set(undefined, tx);
            ref.fileExtension.set(res.fileExtension, tx);
        } else if ('updating' in res) {
            ref.state.set('updating', tx);
            ref.value.set(undefined, tx);
            ref.error.set(undefined, tx);
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
    }
}

const promiseResolvedBindingName = '$$debugValueEditorPromiseResolved';
interface PromiseResolvedBindingNamePayload {
    expression: string;
    result: EvaluationResult;
}

type EvaluationResult = { value: unknown; fileExtension?: string } | { error: string; } | { updating: string };

const refreshBindingName = '$$debugValueEditorRefresh';

export class JsProperty extends Disposable implements IProperty {
    public didUpdate = false;

    public readonly value = observableValue<string | undefined>(this, undefined);
    public readonly fileExtension = observableValue<string | undefined>(this, undefined);
    public readonly error = observableValue<string | undefined>(this, undefined);
    public readonly state = observableValue<'initializing' | 'upToDate' | 'updating' | 'error'>(this, 'initializing');

    constructor(
        public readonly debugSession: JsDebugSession,
        public readonly expression: string,
        initialValue: string | undefined
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
