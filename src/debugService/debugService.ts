import { Disposable, IDisposable } from "../utils/disposables";
import { IObservable, autorun } from "../utils/observables/observable";
import { derivedWithStore } from "../utils/observables/observableInternal/derived";
import { ErrorMessage } from "../utils/utils";
import { DebugSessionProxy, DebugSessionService } from "./DebugSessionService";

export class ActiveSessionPropertyFactory extends Disposable {
    constructor(
        private readonly _debugSessionService: DebugSessionService,
        private readonly _valueContainerFactory: IPropertyFactory,
    ) {
        super();
    }

    createActiveContextProperty(expression: string): IProperty {
        return new DispatchingProperty(expression, this._debugSessionService, this._valueContainerFactory);
    }
}

export interface IPropertyFactory extends IDisposable {
    createProperty(debugSession: DebugSessionProxy, expression: string, initialValue: string | undefined): IProperty | undefined;
}

export interface IProperty extends IDisposable {
    readonly expression: string;

    readonly value: IObservable<string | undefined>;
    readonly fileExtension: IObservable<string | undefined>;
    readonly error: IObservable<string | undefined>;
    readonly state: IObservable<'noSession' | 'initializing' | 'upToDate' | 'updating' | 'error'>;

    setValue(newValue: string): Promise<void | ErrorMessage>;
    refresh(): void;
}

class DispatchingProperty extends Disposable implements IProperty {
    private readonly _targetProperty = derivedWithStore(this, (reader, store) => {
        const session = this.debugSessionService.activeSession.read(reader);
        if (!session) { return undefined; }

        const property = store.add(this.propertyFactory.createProperty(session, this.expression, this._lastValueIfSetByUser));

        if (property) {
            store.add(autorun(reader => {
                const newValue = property.value.read(reader);
                if (newValue !== this._lastValueIfSetByUser) {
                    this._lastValueIfSetByUser = undefined;
                }
            }));
        }

        return property;
    }).recomputeInitiallyAndOnChange(this._store);

    constructor(
        public readonly expression: string,
        private readonly debugSessionService: DebugSessionService,
        private readonly propertyFactory: IPropertyFactory,
    ) {
        super();
    }

    public readonly value = this._targetProperty.map(this, (v, reader) => v?.value.read(reader));
    public readonly fileExtension = this._targetProperty.map(this, (v, reader) => v?.fileExtension.read(reader));
    public readonly error = this._targetProperty.map(this, (v, reader) => v?.error.read(reader));
    public readonly state = this._targetProperty.map(this, (v, reader) => v?.state.read(reader) ?? 'noSession');

    private _lastValueIfSetByUser: string | undefined = undefined;

    async setValue(newValue: string): Promise<void | ErrorMessage> {
        this._lastValueIfSetByUser = newValue;

        const p = this._targetProperty.get();
        if (!p) { return new ErrorMessage('No active debug session'); }
        await p.setValue(newValue);
    }

    refresh(): void {
        this._targetProperty.get()?.refresh();
    }
}
