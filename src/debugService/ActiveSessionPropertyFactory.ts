import { Disposable } from "../utils/disposables";
import { derived, derivedWithStore, autorun } from "../utils/observables/observable";
import { ErrorMessage } from "../utils/utils";
import { DebugSessionService } from "./DebugSessionService";
import { IDebugSupport, IProperty } from "./IDebugSupport";


export class ActiveSessionPropertyFactory extends Disposable {
    constructor(
        private readonly _debugSessionService: DebugSessionService,
        private readonly _debugSupport: IDebugSupport
    ) {
        super();
    }

    createActiveContextProperty(expression: string, sessionName: string | undefined): IProperty {
        return new DispatchingProperty(expression, this._debugSessionService, this._debugSupport, sessionName);
    }
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
        private readonly sessionName: string | undefined
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
