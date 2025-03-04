import type { ObsDeclarationId, ObsInstanceId, ObsInstancePushState, ObsDebuggerApi, DeepPartial, IObservableValueInstancePushState, IDerivedObservableInstancePushState, IAutorunInstancePushState, IDerivedObservableDetailedInfo, IAutorunDetailedInfo, ITransactionState, ObserverInstanceState, DerivedObservableState, AutorunState, IObservableInstancePushState, IObservableValueInfo } from "./debuggerApi";
import { DebugSessionProxy } from "../debugService/DebugSessionService";
import { Disposable } from "../utils/disposables";
import { observableSignal, IReader, observableValue, transaction, ITransaction, IObservable, ISettableObservable, autorun, derived } from "../utils/observables/observableInternal";
import { BugIndicatingError } from "../utils/observables/observableInternal/commonFacade/deps";
import { IChannel, SimpleTypedRpcConnection } from "./rpc";
import { isDefined } from "../utils/utils";

export class ObservableDevToolsModel extends Disposable {
    private readonly _declarations = new Map<ObsDeclarationId, ObsDeclaration>();
    private readonly _declarationsChanged = observableSignal(this);
    public readonly _observables = new Map<ObsInstanceId, ObsInstanceContainer>();
    private readonly _observablesChanged = observableSignal(this);

    private readonly _rpc = SimpleTypedRpcConnection.createHost<ObsDebuggerApi>(this._channel, {
        notifications: {
            handleChange: (update, clearState) => {
                transaction(tx => {
                    if (clearState) {
                        this._observables.clear();
                        this._observablesChanged.trigger(tx);

                        this._declarations.clear();
                        this._declarationsChanged.trigger(tx);
                    }

                    if (update.decls) {
                        for (const d of Object.values(update.decls)) {
                            const decl = new ObsDeclaration(d.id);
                            this._declarations.set(d.id, decl);
                            this._session.getPreferredUILocation({ url: d.url, line: d.line - 1, column: d.column - 1 }).then(result => {
                                decl.resolvedLocation.set(new SourceLocation(result.source.path, result.line + 1, result.column + 1), undefined);
                            });
                        }
                        this._declarationsChanged.trigger(tx);
                    }
                    if (update.instances) {
                        let didChange = false;
                        for (const [key, d] of Object.entries(update.instances)) {
                            const instanceId = Number(key);
                            if (!d) {
                                this._observables.delete(instanceId);
                                didChange = true;
                            } else {
                                let e = this._observables.get(instanceId);
                                if (!e) {
                                    e = new ObsInstanceContainer(d as any, this);
                                    this._observables.set(instanceId, e);
                                    didChange = true;
                                } else {
                                    e.update(d, tx);
                                }
                            }
                        }
                        if (didChange) {
                            this._observablesChanged.trigger(tx);
                        }
                    }
                });

            },
        },
        requests: {},
    });

    private readonly _transactionState = observableValue<ITransactionState | undefined>(this, undefined);
    private readonly _statesByInstanceId = this._transactionState.map(s => new Map(s?.affected.map(s => [s.instanceId, s]) ?? []));

    constructor(private readonly _channel: IChannel, private readonly _session: DebugSessionProxy) {
        super();

        this._rpc.api.notifications.resetUpdates();

        this._register(autorun(async reader => {
            const frameId = this._session.pausedStackFrameId.read(reader);
            if (frameId) {
                this._rpc.api.notifications.flushUpdates();
                try {
                    const result = await this._rpc.api.requests.getTransactionState();
                    this._transactionState.set(result, undefined);
                } catch (e) {
                    // debugger;
                    console.error(e);
                }
            } else {
                this._transactionState.set(undefined, undefined);
            }
        }));
    }

    public getState(instanceId: ObsInstanceId, reader: IReader | undefined): ObserverInstanceState | undefined {
        return this._statesByInstanceId.read(reader)?.get(instanceId);
    }

    public getValue(instanceId: ObsInstanceId): Promise<unknown> {
        return this._rpc.api.requests.getValue(instanceId);
    }

    public getObsInstanceInfo(instanceId: ObsInstanceId, reader: IReader | undefined): ObsInstanceInfo | undefined {
        return this._observables.get(instanceId)?.info;
    }

    public getDeclarationsInFile(path: string, reader: IReader | undefined): ObsDeclaration[] {
        this._declarationsChanged.read(reader);
        return [...this._declarations.values()].filter(d => d.resolvedLocation.read(reader)?.path.toLowerCase() === path.toLowerCase());
    }

    public getInstancesByDeclaration(declaration: ObsDeclaration, reader: IReader | undefined): ObsInstanceInfo[] {
        this._observablesChanged.read(reader);
        return [...this._observables.values()].filter(e => e.info.declarationId === declaration.declarationId).map(e => e.info);
    }

    public async getDerivedInfo(instanceId: ObsInstanceId): Promise<IDerivedObservableDetailedInfo> {
        return await this._rpc.api.requests.getDerivedInfo(instanceId);
    }

    public async getAutorunInfo(instanceId: ObsInstanceId): Promise<IAutorunDetailedInfo> {
        return await this._rpc.api.requests.getAutorunInfo(instanceId);
    }

    public async getObservableValueInfo(instanceId: ObsInstanceId): Promise<IObservableValueInfo> {
        return await this._rpc.api.requests.getObservableValueInfo(instanceId);
    }

    public async setValue(instanceId: ObsInstanceId, jsonValue: unknown) {
        await this._rpc.api.requests.setValue(instanceId, jsonValue);
    }
}

export class ObsDeclaration {
    public readonly resolvedLocation = observableValue<SourceLocation | undefined>(this, undefined);

    constructor(
        public readonly declarationId: ObsDeclarationId,
    ) { }
}

class ObsInstanceContainer {
    public readonly info: ObsInstanceInfo;
    private readonly _data: ISettableObservable<ObsInstancePushState>;

    constructor(data: ObsInstancePushState, model: ObservableDevToolsModel) {
        this._data = observableValue(this, data);
        this.info = ObsInstanceInfoBase.create(this._data, model);
    }

    update(update: DeepPartial<ObsInstancePushState>, tx: ITransaction): void {
        this._data.set(Object.assign({}, this._data, update) as any, tx);
    }
}

export type ObsInstanceInfo = ObsObservableValueInfo | ObsDerivedInfo | ObsAutorunInfo;

export abstract class ObsInstanceInfoBase<
    TPushState extends ObsInstancePushState = ObsInstancePushState,
    TPausedState extends ObserverInstanceState = ObserverInstanceState
> {
    public static create(data: IObservable<ObsInstancePushState>, model: ObservableDevToolsModel): ObsInstanceInfo {
        switch (data.get().type) {
            case 'observable/value':
                return new ObsObservableValueInfo(data as any, model);
            case 'observable/derived':
                return new ObsDerivedInfo(data as any, model);
            case 'autorun':
                return new ObsAutorunInfo(data as any, model);
        }
        throw new BugIndicatingError();
    }

    public readonly instanceId = this._pushState.get().instanceId;
    public readonly declarationId = this._pushState.get().declarationId;
    public readonly name = this._pushState.get().name;

    protected readonly _pausedState = derived(reader => this._model.getState(this.instanceId, reader) as TPausedState | undefined);

    constructor(
        protected readonly _pushState: IObservable<TPushState>,
        protected readonly _model: ObservableDevToolsModel,
    ) { }

    abstract getMessage(reader: IReader): string;
}

export abstract class AbstractObsObservableInfo<
    T extends ObsInstancePushState & IObservableInstancePushState,
    TState extends ObserverInstanceState
> extends ObsInstanceInfoBase<T, TState> {
    public readonly value = this._pushState.map(d => d.formattedValue);
}

export class ObsObservableValueInfo extends AbstractObsObservableInfo<IObservableValueInstancePushState, never> {
    public readonly type = 'value';

    public getMessage(reader: IReader): string {
        return `{ value: ${this.value.read(reader)} }`;
    }
}

export class ObsDerivedInfo extends AbstractObsObservableInfo<IDerivedObservableInstancePushState, DerivedObservableState> {
    public readonly type = 'derived';

    public readonly recomputedCount = this._pushState.map(d => d.recomputationCount);

    public getMessage(reader: IReader): string {
        const s = this._pausedState.read(reader);
        if (s) {
            if (s.state === 'stale' || s.state === 'updating') {
                const names = s.changedDependencies.map(id => this._model.getObsInstanceInfo(id, reader)?.name).filter(isDefined).join(', ');
                return `${s.state} (changed deps: ${names})`;
            }
            return s.state;
        }

        return `{ value: ${this.value.read(reader)} (${this.recomputedCount.read(reader)} recomputes) }`;
    }
}

export class ObsAutorunInfo extends ObsInstanceInfoBase<IAutorunInstancePushState, AutorunState> {
    public readonly type = 'autorun';
    public readonly runCount = this._pushState.map(d => d.runCount);

    public getMessage(reader: IReader): string {
        const s = this._pausedState.read(reader);
        if (s) {
            if (s.state === 'stale' || s.state === 'updating') {
                const names = s.changedDependencies.map(id => this._model.getObsInstanceInfo(id, reader)?.name).filter(isDefined).join(', ');
                return `${s.state} (changed deps: ${names})`;
            }
            return s.state;
        }
        return `runCount: ${this.runCount.read(reader)}`;
    }
}

class SourceLocation {
    constructor(
        public readonly path: string,
        public readonly line: number,
        public readonly column: number,
    ) { }

    toString(): string {
        return `${this.path}:${this.line}:${this.column}`;
    }
}
