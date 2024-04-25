import { Disposable, IDisposable } from "../utils/disposables";
import { IObservable, autorun } from "../utils/observables/observable";
import { derived, derivedWithStore } from "../utils/observables/observableInternal/derived";
import { ErrorMessage } from "../utils/utils";
import { DebugSessionProxy, DebugSessionService } from "./DebugSessionService";
import { AvailablePropertyInfo } from "./JsDebugSupport";

export class ActiveSessionPropertyFactory extends Disposable {
    constructor(
        private readonly _debugSessionService: DebugSessionService,
        private readonly _debugSupport: IDebugSupport,
    ) {
        super();
    }

    createActiveContextProperty(expression: string, sessionName: string | undefined): IProperty {
        return new DispatchingProperty(expression, this._debugSessionService, this._debugSupport, sessionName);
    }
}

export interface IDebugSupport extends IDisposable {
    getAvailableProperties(debugSession: DebugSessionProxy): IObservable<PropertyInformation[]> | undefined;

    createProperty(debugSession: DebugSessionProxy, expression: string, initialValue: string | undefined): IProperty | undefined;

    getRequestHandler(debugSession: DebugSessionProxy): IObservable<IRequestHandler | undefined> | undefined;
}

export interface IRequestHandler {
    sendRequest(requestData: unknown): Promise<void>;
}

export class PropertyInformation {
    static from(e: AvailablePropertyInfo, session: DebugSessionProxy): PropertyInformation {
        if (typeof e === 'string') {
            return new PropertyInformation(e, e, session);
        } else {
            return new PropertyInformation(e.expression, e.label, session);
        }
    }

    constructor(
        public readonly expression: string,
        public readonly label: string,
        public readonly session: DebugSessionProxy,
    ) { }
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
    private readonly _session = derived(this, reader => {
        if (this.sessionName === undefined) {
            return this.debugSessionService.activeSession.read(reader);
        } else {
            return this.debugSessionService.debugSessions.read(reader).find(s => s.session.name === this.sessionName);
        }
    });

    private readonly _targetProperty = derivedWithStore(this, (reader, store) => {
        const session = this._session.read(reader);
        if (!session) { return undefined; }

        const property = store.add(this.debugSupport.createProperty(session, this.expression, this._lastValueIfSetByUser));

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
        private readonly debugSupport: IDebugSupport,
        private readonly sessionName: string | undefined,
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
