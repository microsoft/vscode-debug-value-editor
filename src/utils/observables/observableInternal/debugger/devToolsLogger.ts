import { AutorunObserver } from "../autorun";
import { IObservable, ObservableValue, TransactionImpl } from "../base";
import { Derived } from "../derived";
import { formatValue, IChangeInformation, IObservableLogger } from "../logging";
import { FromEventObservable } from "../utils";
import { DebuggerApi, DeclarationId, IDeclaration } from "./debuggerApi";
import { registerDebugChannel } from "./debuggerRpc";
import { getFirstStackFrameOutsideOf } from "./utils";


interface IObservableInfo {
    declarationId: number;
    entityId: number;

    listenerCount: number;
    lastValue: string | undefined;
}

export class DevToolsLogger implements IObservableLogger {
    private static _instance: DevToolsLogger | undefined = undefined;
    public static getInstance(): DevToolsLogger {
        if (DevToolsLogger._instance === undefined) {
            DevToolsLogger._instance = new DevToolsLogger();
        }
        return DevToolsLogger._instance;
    }

    private _declarationId = 0;
    private _entityId = 0;

    private readonly _declarations = new Map</* declarationId */string, IDeclaration>();
    private readonly _weakMapObservableInfo = new WeakMap<IObservable<any>, IObservableInfo>();

    private readonly _channel = registerDebugChannel<DebuggerApi>('observableDevTools', () => {
        return {
            notifications: {
                setDeclarationIdFilter: declarationIds => {

                },
                logObservableValue: (observableId) => {
                    console.log('logObservableValue', observableId);
                },
            },
            requests: {
                getDeclarations: () => {
                    const result: Record<string, IDeclaration> = {};
                    for (const decl of this._declarations.values()) {
                        result[decl.id] = decl;
                    }
                    return { decls: result };
                },
                getSummarizedEntities: () => {
                    return null!;
                },
            }
        };
    });

    private constructor() { }

    handleObservableCreated(observable: IObservable<any>): void {
        const stack = new Error().stack!;
        const loc = getFirstStackFrameOutsideOf(stack, 'observableInternal');

        let decInfo = this._declarations.get(loc.id);
        if (decInfo === undefined) {
            const decId = this._declarationId++;
            decInfo = {
                id: decId,
                type: 'observable/value',
                url: loc.fileName,
                line: loc.line,
                column: loc.column,
            };
            this._declarations.set(loc.id, decInfo);

            this._channel.api.notifications.handleChange({ decls: { [decId]: decInfo } });
        }

        const info: IObservableInfo = {
            declarationId: decInfo.id,
            entityId: this._entityId++,
            listenerCount: 0,
            lastValue: undefined,
        };
        this._weakMapObservableInfo.set(observable, info);
    }

    handleOnListenerCountChanged(observable: IObservable<any>, newCount: number): void {
        const info = this._weakMapObservableInfo.get(observable);
        if (info) {
            if (info.listenerCount === 0 && newCount > 0) {
                this._channel.api.notifications.handleChange({
                    entities: {
                        [info.entityId]: {
                            entityId: info.entityId,
                            declarationId: info.declarationId,
                            formattedValue: undefined,
                            type: 'observable/value',
                            name: observable.debugName,
                        }
                    }
                });
            } else if (info.listenerCount > 0 && newCount === 0) {
                this._channel.api.notifications.handleChange({
                    entities: { [info.entityId]: null }
                });
            }
            info.listenerCount = newCount;
        }
    }

    handleObservableChanged(observable: ObservableValue<any>, changeInfo: IChangeInformation): void {
        const info = this._weakMapObservableInfo.get(observable);
        if (info) {
            if (changeInfo.didChange) {
                this._channel.api.notifications.handleChange({
                    entities: { [info.entityId]: { formattedValue: formatValue(changeInfo.newValue, 100) } }
                });
            }
        }
    }

    handleFromEventObservableTriggered(observable: FromEventObservable<any, any>, info: IChangeInformation): void {

    }

    handleAutorunCreated(autorun: AutorunObserver): void {

    }
    handleAutorunRan(autorun: AutorunObserver): void {

    }
    handleAutorunFinished(autorun: AutorunObserver): void {

    }
    handleDerivedCreated(observable: Derived<any>): void {

    }
    handleDerivedRecomputed(observable: Derived<any>, changeInfo: IChangeInformation): void {
        const info = this._weakMapObservableInfo.get(observable);
        if (info) {
            const formattedValue = formatValue(changeInfo.newValue, 100);

            info.lastValue = formattedValue;
            this._channel.api.notifications.handleChange({
                entities: { [info.entityId]: { formattedValue: formattedValue } }
            });
        }
    }
    handleDerivedCleared(observable: Derived<any>): void {
        const info = this._weakMapObservableInfo.get(observable);
        if (info) {
            info.lastValue = undefined;
            this._channel.api.notifications.handleChange({
                entities: {
                    [info.entityId]: {
                        formattedValue: undefined,
                    }
                }
            });
        }
    }
    handleBeginTransaction(transaction: TransactionImpl): void {

    }
    handleEndTransaction(): void {

    }
}
