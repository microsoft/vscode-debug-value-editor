import { DecorationOptions, languages, MarkdownString, Position, Range, TextEditorRevealType, ThemeColor, Uri, window } from "vscode";
import { DebugSessionService } from "../debugService/DebugSessionService";
import { IDebugSupport } from "../debugService/IDebugSupport";
import { Disposable } from "../utils/disposables";
import { autorun } from "../utils/observables/observable";
import { constObservable, mapObservableArrayCached, observableFromEvent } from "../utils/observables/observableInternal/utils";
import { createRpcChannelFromDebugChannel } from "./createConnectorFromDebugClient";
import { isDefined } from "../utils/utils";
import { ObservableDevToolsModel } from "./ObservableDevToolsModel";
import { IObsInstanceRef, ObsInstanceId } from "./debuggerApi";
import { CommandDef } from "../Command";
import { assumeType } from "../utils/Validator";

export class ObservableDevToolsFeature extends Disposable {
    private readonly _openEditors = observableFromEvent(window.onDidChangeVisibleTextEditors, () => [...window.visibleTextEditors]);

    constructor(
        private readonly _debugSessionService: DebugSessionService,
        private readonly _debugSupport: IDebugSupport,

    ) {
        super();

        const setValueCommand = new CommandDef('observableDevTools.setValue', assumeType<{ instanceId: ObsInstanceId }>());
        const recomputeCommand = new CommandDef('observableDevTools.recompute', assumeType<{ instanceId: ObsInstanceId }>());
        const logValueCommand = new CommandDef('observableDevTools.log', assumeType<{ instanceId: ObsInstanceId }>());
        const goToLocationCommand = new CommandDef('observableDevTools.goToLocation', assumeType<{ instanceId: ObsInstanceId }>());

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

        this._register(setValueCommand.register(async (args) => {
            const s = firstState.get();
            if (!s) { return undefined; }

            const val = await s.getValue(args.instanceId);

            const result = await window.showInputBox({
                prompt: 'Enter JSON value',
                value: '' + val,
            });
            if (result === undefined) { return; }

            await s.setValue(args.instanceId, JSON.parse(result));
        }));

        this._register(logValueCommand.register(async (args) => {
            const s = firstState.get();
            if (!s) { return undefined; }
            await s.logValue(args.instanceId);
        }));

        this._register(recomputeCommand.register(async (args) => {
            const s = firstState.get();
            if (!s) { return undefined; }
            await s.rerun(args.instanceId);
        }));

        const d = this._register(window.createTextEditorDecorationType({
            isWholeLine: true,
            backgroundColor: new ThemeColor("editor.inlineValuesBackground"),
        }));

        this._register(goToLocationCommand.register(async (args) => {
            const s = firstState.get();
            if (!s) { return undefined; }
            const info = s.getObsInstanceInfo(args.instanceId, undefined);
            if (!info) { return undefined; }
            const decl = s.getDeclaration(info.declarationId, undefined);
            const loc = decl?.resolvedLocation.get();
            if (!loc) { return undefined; }
            const e = await window.showTextDocument(Uri.file(loc.path));
            e.revealRange(new Range(loc.line - 1, loc.column - 1, loc.line - 1, loc.column - 1), TextEditorRevealType.InCenterIfOutsideViewport);

            const decoration: DecorationOptions = {
                range: new Range(new Position(loc.line - 1, 0), new Position(loc.line - 1, Number.MAX_SAFE_INTEGER)),
                renderOptions: {
                    dark: {

                    }
                }
            };
            e.setDecorations(d, [decoration]);
            setTimeout(() => e.setDecorations(d, []), 600);
        }));

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
                    function addLinkToDecl(ref: IObsInstanceRef, content: string): string {
                        return goToLocationCommand.toMarkdownCommand(content, { instanceId: ref.instanceId });
                    }

                    function formatRefs(refs: IObsInstanceRef[]): string {
                        return refs.map(r => ` * ${addLinkToDecl(r, formatInlineCode(r.name))}`).join('\n');
                    }

                    const contents = await Promise.all(instances.map(async i => {
                        if (i.type === 'autorun') {
                            const info = await s.getAutorunInfo(i.instanceId);
                            const deps = `#### Dependencies\n${formatRefs(info.dependencies)}`;
                            const m = new MarkdownString(`
### Autorun ${formatInlineCode(i.name)}

[${recomputeCommand.toMarkdownCommand('Rerun', { instanceId: i.instanceId })}]

${deps}
`);
                            m.isTrusted = true;
                        } else if (i.type === 'derived') {
                            const info = await s.getDerivedInfo(i.instanceId);
                            const val = await s.getValue(i.instanceId);
                            const deps = `#### Dependencies\n${formatRefs(info.dependencies)}`;
                            const obs = `#### Observers\n${formatRefs(info.observers)}`;
                            const m = new MarkdownString(`
### Derived ${formatInlineCode(i.name)}
Value: \`${val}\`

[${setValueCommand.toMarkdownCommand('Set Value', { instanceId: i.instanceId })}]
[${logValueCommand.toMarkdownCommand('Log Value', { instanceId: i.instanceId })}]
[${recomputeCommand.toMarkdownCommand('Recompute', { instanceId: i.instanceId })}]

${deps}

${obs}
---
`);
                            m.isTrusted = true;
                            return m;
                        } else if (i.type === 'value') {
                            const info = await s.getObservableValueInfo(i.instanceId);
                            const val = await s.getValue(i.instanceId);
                            const observersSection = info?.observers.length ? `
#### Observers
${formatRefs(info.observers)}` : '';

                            const m = new MarkdownString(`
### ObservableValue ${formatInlineCode(i.name)}
Value: \`${val}\`

[${setValueCommand.toMarkdownCommand('Set Value', { instanceId: i.instanceId })}]
[${logValueCommand.toMarkdownCommand('Log Value', { instanceId: i.instanceId })}]

${observersSection}
---`);
                            m.isTrusted = true;
                            return m;
                        }
                        return '';
                    }));

                    return { contents };
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
