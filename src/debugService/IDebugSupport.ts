import { Event } from "vscode";
import { IDisposable } from "../utils/disposables";
import { IObservable } from "../utils/observables/observable";
import { ErrorMessage } from "../utils/utils";
import { DebugSessionProxy } from "./DebugSessionService";
import { AvailablePropertyInfo } from "./JsDebugSupport";

export interface IDebugSupport extends IDisposable {
    getAvailableProperties(debugSession: DebugSessionProxy): IObservable<PropertyInformation[]> | undefined;

    createProperty(debugSession: DebugSessionProxy, expression: string, initialValue: string | undefined): IProperty | undefined;

    getAvailableChannels(debugSession: DebugSessionProxy): IObservable<readonly IDebugChannel[]>;
    getChannel(debugSession: DebugSessionProxy, channelId: string): IObservable<IDebugChannel | undefined>;
}

export interface ISourceLocation {
    fileName: string;
    line: number;
    column: number;
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
        public readonly expression: string | undefined,
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

export interface IDebugChannel {
    get channelId(): string;

    sendRequest(requestData: unknown): Promise<unknown>;

    listenForNotifications(): void;
    onNotification: Event<{ notificationData: unknown }>;

    toString(): string;
}
