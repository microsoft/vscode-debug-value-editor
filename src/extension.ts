import { EventEmitter, ExtensionContext, ProgressLocation, TreeDataProvider, TreeItem, TreeItemCollapsibleState, ViewColumn, commands, debug, window, workspace } from "vscode";
import { OpenPropertyCodeLensFeature } from "./CodeLensFeature";
import { CommandDef } from "./Command";
import { PropertyInformation } from "./debugService/IDebugSupport";
import { DebugValueEditorService, SessionInformation } from "./DebugValueEditService";
import { ObservableDevToolsFeature } from "./observableDevTools/ObservableDevToolsFeature";
import { Disposable, DisposableStore } from "./utils/disposables";
import { IObservable, autorun, constObservable, derived, derivedObservableWithCache, observableFromEvent, observableValue } from "./utils/observables/observable";
import { mapObservableArrayCached } from "./utils/observables/observableInternal/utils";
import { ErrorMessage, isDefined, setContextKey } from "./utils/utils";
import { assumeType } from "./utils/Validator";
import { hotReloadExportedItem } from "@hediet/node-reload";
import { waitForState } from "./utils/observables/observableInternal/utilsCancellation";

export class Extension extends Disposable {
    private readonly _debugValueEditService = this._register(new DebugValueEditorService());

    constructor(context: ExtensionContext) {
        super();

        const visibleProperty = observableValue<IObservable<boolean>>(this, constObservable(false));

        const treeView = this._register(window.createTreeView('available-properties', {
            treeDataProvider: new TreeDataProviderImpl(
                derived(reader => visibleProperty.read(reader).read(reader) ? this._debugValueEditService.availableProperties.read(reader) : [])
            )
        }));

        treeView.message = 'Click on an available property to edit or view its value.';
        visibleProperty.set(observableFromEvent(treeView.onDidChangeVisibility, () => treeView.visible), undefined);

        this._register(new OpenPropertyCodeLensFeature());
        this._register(hotReloadExportedItem(ObservableDevToolsFeature, ObservableDevToolsFeature => new ObservableDevToolsFeature(this._debugValueEditService.debugSessionService, this._debugValueEditService.debugSupport)));
        this._register(editPropertyCommand.register(async (args) => {
            const expressions = args.expressions;
            let first = true;
            for (const expression of expressions) {
                if (!first) {
                    await commands.executeCommand('workbench.action.newGroupBelow');
                }
                const expr = typeof expression === 'string' ? expression : expression.expression;
                const label = typeof expression === 'string' ? undefined : expression.label;

                const result = await this._debugValueEditService.editProperty(
                    expr,
                    args.debugSessionName,
                    label,
                    first ? ViewColumn.Beside : ViewColumn.Active
                );
                if (ErrorMessage.showIfError(result)) {
                    return;
                }
                first = false;
            }
        }));

        const hasAvailableProperties = derived(this, reader => this._debugValueEditService.availableProperties.read(reader).length > 0);
        const everHadAvailableProperties = derivedObservableWithCache<boolean>(this, (reader, lastValue) => lastValue || hasAvailableProperties.read(reader));
        const setContextKeyPromise = derived(this, async (reader) => {
            const val = everHadAvailableProperties.read(reader);
            await setContextKey("debug-value-editor.has-available-properties", val);
        }).recomputeInitiallyAndOnChange(this._store);


        this._register(debugAndSendRequestCommand.register(async (args) => {
            const store = new DisposableStore();
            try {
                // The parentSession check is a hack, because the js debugger spawns two sessions :/
                const targetDebugSession = this._debugValueEditService.debugSessionService.debugSessions
                    .map((sessions, reader) => sessions.map(
                        s => {
                            if (!s.findSelfOrParent(s => s.configuration.name === args.launchConfigName)) {
                                return undefined;
                            }
                            const channel = this._debugValueEditService.debugSupport.getChannel(s, args.channelId ?? 'run').read(reader);
                            if (!channel) { return undefined; }
                            return { session: s, channel };
                        }
                    ).find(isDefined));

                targetDebugSession.keepObserved(store);

                if (!targetDebugSession.get()) {
                    await debug.startDebugging(workspace.workspaceFolders![0], args.launchConfigName);
                    await waitForState(targetDebugSession, session => session !== undefined);
                    if (args.revealAvailablePropertiesView) {
                        window.withProgress({ title: 'Waiting for visualizable properties', location: ProgressLocation.Notification, cancellable: true }, async (p, token) => {
                            let cancelled = false;
                            token.onCancellationRequested(() => {
                                cancelled = true;
                            });
                            await Promise.race([
                                waitForState(targetDebugSession, session => session === undefined),
                                (async () => {
                                    await waitForState(this._debugValueEditService.availableProperties, p => p.length > 0);
                                    await setContextKeyPromise.get();
                                    if (cancelled) {
                                        return;
                                    }

                                    commands.executeCommand('available-properties.focus');
                                })()
                            ]);
                            cancelled = true;
                        });
                    }
                }
                const session = targetDebugSession.get();
                if (!session) { return; }

                try {
                    return await session.channel.sendRequest(args.args);
                } catch (e) {
                    console.error(e);
                    window.showErrorMessage('Error sending request: ' + e);
                }
            } finally {
                store.dispose();
            }
        }));
    }
}

export const editPropertyCommand = new CommandDef('debug-value-editor.edit-property', assumeType<{
    expressions: (string | { expression: string, label?: string })[];
    debugSessionName?: string,
}>());

export const debugAndSendRequestCommand = new CommandDef('debug-value-editor.debug-and-send-request', assumeType<{
    launchConfigName: string;
    channelId?: string; // defaults to "run"
    args: unknown;
    revealAvailablePropertiesView: boolean;
}>());

type T = SessionInformation | PropertyInformation;

export class TreeDataProviderImpl extends Disposable implements TreeDataProvider<T> {
    private readonly _onDidChangeTreeData = this._register(new EventEmitter<T | T[] | void>());
    public readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    constructor(
        private readonly properties: IObservable<SessionInformation[] | 'loading'>,
    ) {
        super();
        const map = mapObservableArrayCached(this, this.properties.map(p => p === 'loading' ? [] : p), (input, store) => {
            store.add(autorun(reader => {
                input.properties.read(reader);
                this._onDidChangeTreeData.fire(input);
            }));
        });
        this._register(autorun(reader => {
            map.read(reader);
            this._onDidChangeTreeData.fire();
        }));
    }

    getTreeItem(element: T): TreeItem | Thenable<TreeItem> {
        if (element instanceof SessionInformation) {
            return {
                id: 'session-' + element.session.session.id,
                label: 'Session ' + element.session.session.name,
                collapsibleState: TreeItemCollapsibleState.Expanded,
            };
        } else if (element instanceof PropertyInformation) {
            return {
                id: 'prop-' + element.expression,
                label: element.label,
                /*description: element.expression,*/
                collapsibleState: TreeItemCollapsibleState.None,
                command: element.expression ? editPropertyCommand.toCommand(
                    { title: 'Edit property' },
                    { expressions: [{ expression: element.expression, label: element.label }], debugSessionName: element.session.session.name }
                ) : undefined,
            }
        } else {
            const x: never = element;
            return x;
        }
    }

    async getChildren(element?: T): Promise<T[]> {
        if (element) {
            if (element instanceof SessionInformation) {
                return element.properties.get();
            } else if (element instanceof PropertyInformation) {
                return [];
            }
        }
        const p = await waitForState(this.properties, p => p !== 'loading');
        return p;
    }

    /*getParent(element: T) {
        throw new Error("Method not implemented.");
    }*/

    /*resolveTreeItem(item: TreeItem, element: T, token: CancellationToken): ProviderResult<TreeItem> {
        return item;
    }*/
}
