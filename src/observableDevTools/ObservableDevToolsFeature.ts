import { Position, Range, window } from "vscode";
import type { DebuggerApi, DeclarationId, ObjectId } from "../../demo/src/observableInternal/debugger/debuggerApi";
import { DebugSessionProxy, DebugSessionService } from "../debugService/DebugSessionService";
import { IDebugSupport } from "../debugService/IDebugSupport";
import { Disposable } from "../utils/disposables";
import { autorun, IReader, observableValue } from "../utils/observables/observable";
import { mapObservableArrayCached, observableFromEvent, observableSignal } from "../utils/observables/observableInternal/utils";
import { createChannelFactoryFromDebugChannel } from "./createChannelFactoryFromDebugClient";
import { ChannelFactory, SimpleTypedRpcConnection } from "./rpc";

export class ObservableDevToolsFeature extends Disposable {
    private readonly _openEditors = observableFromEvent(window.onDidChangeVisibleTextEditors, e => window.visibleTextEditors);

    constructor(
        private readonly _debugSessionService: DebugSessionService,
        private readonly _debugSupport: IDebugSupport,

    ) {
        super();

        const states = mapObservableArrayCached(this, this._debugSessionService.debugSessions, (session, store) => {
            const observableDevToolsChannel = this._debugSupport.getAvailableChannels(session).map(c => c.find(c => c.channelId === 'observableDevTools'));

            return observableDevToolsChannel.map(channel => {
                if (!channel) { return undefined; }

                const channelFactory = createChannelFactoryFromDebugChannel(channel);

                const states = store.add(new ObservableStates(channelFactory, session));
                return states;
            }).recomputeInitiallyAndOnChange(store);

        }).recomputeInitiallyAndOnChange(this._store);

        const type = window.createTextEditorDecorationType({
            isWholeLine: true,
        });

        mapObservableArrayCached(this, this._openEditors, (editor, store) => {

            store.add(autorun(reader => {
                const ss = states.read(reader);
                const observables = ss.flatMap(s => [...s?.read(reader)?.getObservables(reader).values() ?? []]).filter(o => o.declaration.location.read(reader)?.path === editor.document.uri.fsPath);

                editor.setDecorations(type, observables.map(o => ({
                    range: rangeAtLineNumber(o.declaration.location.read(reader)?.line ?? 1),
                    renderOptions: {
                        after: {
                            contentText: '  ' + o.value.read(reader)
                        }
                    }
                })))
            }));

        }).recomputeInitiallyAndOnChange(this._store);

        this._register(autorun(() => {

        }));
    }
}

function rangeAtLineNumber(lineNumber: number) {
    return new Range(new Position(lineNumber - 1, 0), new Position(lineNumber - 1, 0));
}

class SourceDeclaration {
    public readonly location = observableValue<SourceLocation | undefined>(this, undefined);

    constructor(
        public readonly declarationId: DeclarationId,
    ) { }
}

class SourceLocation {
    constructor(
        public readonly path: string,
        public readonly line: number,
        public readonly column: number,
    ) { }
}

class ObservableInfo {
    public readonly value = observableValue<string | undefined>(this, undefined);
    public readonly listenerCount = observableValue<number>(this, 0);

    constructor(
        public readonly observableId: ObjectId,
        public readonly declaration: SourceDeclaration,
    ) { }
}

class ObservableStates extends Disposable {
    private readonly _declarations = new Map<DeclarationId, SourceDeclaration>();
    public readonly _observables = new Map<ObjectId, ObservableInfo>();
    private readonly _observablesSignal = observableSignal(this);

    constructor(channelFactory: ChannelFactory, session: DebugSessionProxy) {
        super();

        const rpc = SimpleTypedRpcConnection.createHost<DebuggerApi>(channelFactory, {
            notifications: {
                onDeclarationDiscovered: (declarationId, type, url, line, column) => {
                    const decl = new SourceDeclaration(declarationId);
                    this._declarations.set(declarationId, decl);
                    session.getPreferredUILocation({ url: url, line: line - 1, column: column - 1 }).then((result) => {
                        decl.location.set(new SourceLocation(result.source.path, result.line + 1, result.column + 1), undefined);
                    });
                },
                onObservableListenerCountChanged: (declarationId, observableId, newListenerCount) => {
                    const declaration = this._declarations.get(declarationId)!;
                    let observable = this._observables.get(observableId);
                    if (!observable) {
                        observable = new ObservableInfo(observableId, declaration);
                        this._observables.set(observableId, observable);
                        this._observablesSignal.trigger(undefined);
                    }
                    observable.listenerCount.set(newListenerCount, undefined);
                },
                onObservableChanged: (observableId, newFormattedValue) => {
                    const observable = this._observables?.get(observableId);
                    if (!observable) { return; }
                    observable.value.set(newFormattedValue, undefined);
                },
            },
            requests: {},
        });
    }

    public getObservables(reader: IReader) {
        this._observablesSignal.read(reader);
        return this._observables;
    }
}
