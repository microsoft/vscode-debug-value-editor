import { AutorunObserver } from "../autorun";
import { IObservable, ObservableValue, TransactionImpl } from "../base";
import { Derived } from "../derived";
import { formatValue, IChangeInformation, IObservableLogger } from "../logging";
import { FromEventObservable } from "../utils";
import { DebuggerApi } from "./debuggerApi";
import { registerDebugChannel } from "./debuggerRpc";
import { getFirstStackFrameOutsideOf } from "./utils";

const channel = registerDebugChannel<DebuggerApi>('observableDevTools', () => {
    return {
        notifications: {
            setFilter: (idsToListenFor) => {

            },
            logObservableValue: (observableId) => {
                console.log('logObservableValue', observableId);
            }
        },
        requests: {
            getObservableValueFormattedValue: (observableId) => {
                return 'test';
            }
        }
    };
});

interface IObservableInfo {
    declarationId: number;
    observableId: number;
}

export class DevToolsLogger implements IObservableLogger {
    private _declarationId = 0;
    private _objectId = 0;

    private readonly _declarations = new Map<string, number>();
    private readonly _weakMapObservableInfo = new WeakMap<IObservable<any, any>, IObservableInfo>();

    handleObservableCreated(observable: IObservable<any, any>): void {
        const stack = new Error().stack!;
        const loc = getFirstStackFrameOutsideOf(stack, 'observableInternal');

        let decId = this._declarations.get(loc.id);
        if (decId === undefined) {
            decId = this._declarationId++;
            this._declarations.set(loc.id, decId);

            channel.api.notifications.onDeclarationDiscovered(
                decId,
                'observable/value',
                loc.fileName,
                loc.line,
                loc.column,
            );
        }

        const info: IObservableInfo = {
            declarationId: decId,
            observableId: this._objectId++,
        };
        this._weakMapObservableInfo.set(observable, info);
    }

    handleOnListenerCountChanged(observable: IObservable<any, any>, newCount: number): void {
        const info = this._weakMapObservableInfo.get(observable);
        if (info) {
            channel.api.notifications.onObservableListenerCountChanged(info.declarationId, info.observableId, newCount);
        }
    }

    handleObservableChanged(observable: ObservableValue<any, any>, info: IChangeInformation): void {
        const observableInfo = this._weakMapObservableInfo.get(observable);
        if (observableInfo) {
            const formattedValue = info.hadValue
                ? info.didChange
                    ? formatValue(info.newValue, 100)
                    : 'unchanged'
                : 'initial';
            channel.api.notifications.onObservableChanged(observableInfo.observableId, formattedValue);
        }
    }
    handleFromEventObservableTriggered(observable: FromEventObservable<any, any>, info: IChangeInformation): void {

    }
    handleAutorunCreated(autorun: AutorunObserver): void {

    }
    handleAutorunTriggered(autorun: AutorunObserver): void {

    }
    handleAutorunFinished(autorun: AutorunObserver): void {

    }
    handleDerivedCreated(observable: Derived<any>): void {

    }
    handleDerivedRecomputed(observable: Derived<any>, info: IChangeInformation): void {
        const observableInfo = this._weakMapObservableInfo.get(observable);
        if (observableInfo) {
            const formattedValue = formatValue(info.newValue, 100);
            /*info.hadValue
                ? info.didChange
                    ? formatValue(info.newValue, 100)
                    : 'unchanged'
                : 'initial';*/
            channel.api.notifications.onObservableChanged(observableInfo.observableId, formattedValue);
        }
    }
    handleBeginTransaction(transaction: TransactionImpl): void {

    }
    handleEndTransaction(): void {

    }
}
