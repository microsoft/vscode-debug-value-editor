import { DecorationOptions, languages, MarkdownString, Position, Range, ThemeColor, window } from "vscode";
import { DebugSessionService } from "../debugService/DebugSessionService";
import { IDebugSupport } from "../debugService/IDebugSupport";
import { Disposable } from "../utils/disposables";
import { autorun } from "../utils/observables/observable";
import { constObservable, mapObservableArrayCached, observableFromEvent } from "../utils/observables/observableInternal/utils";
import { createRpcChannelFromDebugChannel } from "./createConnectorFromDebugClient";
import { isDefined } from "../utils/utils";
import { ObservableDevToolsModel } from "./ObservableDevToolsModel";
import { IObsInstanceRef } from "./debuggerApi";

export class ObservableDevToolsFeature extends Disposable {
    private readonly _openEditors = observableFromEvent(window.onDidChangeVisibleTextEditors, () => [...window.visibleTextEditors]);

    constructor(
        private readonly _debugSessionService: DebugSessionService,
        private readonly _debugSupport: IDebugSupport,

    ) {
        super();

        const states = mapObservableArrayCached(this, this._debugSessionService.debugSessions, (session, store) => {
            const observableDevToolsChannel = this._debugSupport.getChannel(session, 'observableDevTools');

            return observableDevToolsChannel.map(channel => {
                if (!channel) { return undefined; }

                const connectionLink = createRpcChannelFromDebugChannel(channel);

                const states = store.add(new ObservableDevToolsModel(connectionLink, session));
                return states;
            }).recomputeInitiallyAndOnChange(store);

        }).recomputeInitiallyAndOnChange(this._store);

        const firstState = states.map((states, reader) => states.find(s => s.read(reader)) ?? constObservable(undefined)).flatten();

        this._register(languages.registerHoverProvider({ language: 'typescript' }, {
            provideHover: async (document, position, token) => {
                if (document.lineAt(position.line).text.length === position.character) { // end of line
                    const s = firstState.get();
                    if (!s) { return undefined; }
                    const decls = s.getDeclarationsInFile(document.uri.fsPath, undefined);
                    const declsAtLine = decls.filter(d => d.resolvedLocation.get()?.line === position.line + 1);
                    const instances = declsAtLine.flatMap(d => s.getInstancesByDeclaration(d, undefined));


                    function formatInlineCode(value: string): string {
                        return "`" + value + "`";
                    }

                    function formatRefs(refs: IObsInstanceRef[]): string {
                        return refs.map(r => ` * ${formatInlineCode(r.name)}`).join('\n');
                    }

                    return {
                        contents: await Promise.all(instances.map(async i => {
                            if (i.type === 'autorun') {
                                const info = await s.getAutorunInfo(i.instanceId);
                                const deps = `#### Dependencies\n${formatRefs(info.dependencies)}`;
                                return new MarkdownString(`### Autorun ${formatInlineCode(i.name)}\n\n${deps}`);
                            }
                            if (i.type === 'derived') {
                                const info = await s.getDerivedInfo(i.instanceId);
                                const deps = `#### Dependencies\n${formatRefs(info.dependencies)}`;
                                const obs = `#### Observers\n${formatRefs(info.observers)}`;
                                return new MarkdownString(`### Derived ${formatInlineCode(i.name)}\n\n${deps}\n\n${obs}\n---`);
                            }
                            return '';
                        })),
                    };
                }
            }
        }));

        const type = this._register(window.createTextEditorDecorationType({
            isWholeLine: true,
        }));

        mapObservableArrayCached(this, this._openEditors, (editor, store) => {
            const fsPath = editor.document.uri.fsPath;

            store.add(autorun(reader => {
                const s = firstState.read(reader);
                let decorationOptions: DecorationOptions[];
                if (!s) {
                    decorationOptions = [];
                } else {
                    const declarations = s?.getDeclarationsInFile(fsPath, reader) ?? [];
                    const declarationsByLine = groupBy(declarations, d => d.resolvedLocation.read(reader)?.line);

                    decorationOptions = [...declarationsByLine].map<DecorationOptions | undefined>(([line, declaration]) => {
                        if (line === undefined) { return undefined; }
                        const instances = declaration.flatMap(d => s.getInstancesByDeclaration(d, reader));

                        return {
                            range: rangeAtLineNumber(line),
                            renderOptions: {
                                after: {
                                    contentText: ' ' + instances.map(o => o.getMessage(reader)).join(', '),
                                    color: new ThemeColor("editor.inlineValuesForeground"),
                                },
                            }
                        };
                    }).filter(isDefined);
                }
                editor.setDecorations(type, decorationOptions);
            }));

        }).recomputeInitiallyAndOnChange(this._store);
    }
}

function groupBy<T, TKey>(items: T[], keySelector: (item: T) => TKey): Map<TKey, T[]> {
    const result = new Map<TKey, T[]>();
    for (const item of items) {
        const key = keySelector(item);
        let group = result.get(key);
        if (!group) {
            group = [];
            result.set(key, group);
        }
        group.push(item);
    }
    return result;
}

function rangeAtLineNumber(lineNumber: number) {
    return new Range(new Position(lineNumber - 1, 0), new Position(lineNumber - 1, 0));
}
