import { TabInputCustom, TabInputNotebook, TabInputNotebookDiff, TabInputTerminal, TabInputText, TabInputTextDiff, TabInputWebview, Uri, ViewColumn, window, workspace } from "vscode";
import { SyncedTextDocument } from "./VirtualDocument";
import { registerVirtualFs } from "./VirtualFileSystemController";
import { DebugSessionProxy, DebugSessionService } from "./debugService/DebugSessionService";
import { IDebugSupport, IProperty, PropertyInformation } from "./debugService/IDebugSupport";
import { ActiveSessionPropertyFactory } from "./debugService/ActiveSessionPropertyFactory";
import { JsDebugSupport } from "./debugService/JsDebugSupport";
import { Disposable, RefCounted } from "./utils/disposables";
import { IObservable, derived, derivedObservableWithCache, observableFromEvent, waitForState } from "./utils/observables/observable";
import { mapObservableArrayCached } from "./utils/observables/observableInternal/utils";
import { ErrorMessage, showDocument } from "./utils/utils";
import { toDisposable } from "./utils/observables/observableInternal/lifecycle";

export class DebugValueEditorService extends Disposable {
    public readonly debugSessionService = this._register(new DebugSessionService());
    public readonly debugSupport: IDebugSupport = this._register(new JsDebugSupport());
    private readonly _activeSessionPropertyFactory = this._register(new ActiveSessionPropertyFactory(this.debugSessionService, this.debugSupport));

    private readonly _openedUris = observableFromEvent(
        window.tabGroups.onDidChangeTabs,
        () => new Set(window.tabGroups.all.flatMap(g => g.tabs).flatMap(i => inputToUris(i.input)).map(uri => uri.toString())),
    );
    private readonly _textDocuments = observableFromEvent(workspace.onDidOpenTextDocument, e => workspace.textDocuments);
    private readonly _visibleDocuments = derived(this, (reader) => {
        const opened = this._openedUris.read(reader);
        const docs = this._textDocuments.read(reader);
        return docs.filter(d => opened.has(d.uri.toString()));
    });

    private readonly _syncedTextDocuments = mapObservableArrayCached(this, this._visibleDocuments, (doc, store) => {
        const parsed = parseUri(doc.uri);
        if (!parsed) { return undefined; }

        const property = this.getProperty(parsed.expression, parsed.sessionName);

        //window.tabGroups.all[0].tabs[0]

        if (ErrorMessage.showIfError(property)) {
            return;
        }

        const propRef = store.add(property.clone());
        const s = store.add(new SyncedTextDocument(doc, {
            setValue: async (newValue) => {
                const result = await propRef.value.setValue(newValue);
                if (ErrorMessage.showIfError(result)) {
                    return;
                }
            },
            value: derivedObservableWithCache(this, (reader, lastVal) => propRef.value.value.read(reader) ?? lastVal ?? ''),
        }));
        store.add(toDisposable(() => {
            const file = this._fs.getExistingFile(doc.uri);
            file?.deleteFile();
        }))

        return s;
    });

    private readonly _availableProperties = mapObservableArrayCached(this, this.debugSessionService.debugSessions, (session, store) => {
        const props = this.debugSupport.getAvailableProperties(session);
        if (!props) { return undefined; }
        return new SessionInformation(session, props);
    });

    public readonly availableProperties = derived(this, reader => {
        const props = this._availableProperties.read(reader);
        return props.filter(isDefined).filter(p => p.hasProperties.read(reader));
    });


    constructor() {
        super();

        this._syncedTextDocuments.recomputeInitiallyAndOnChange(this._store)
    }

    private readonly _fs = this._register(registerVirtualFs({
        scheme: scheme,
        getInitialContent: async uri => {
            const parsed = parseUri(uri);
            if (!parsed) { throw new Error('invalid uri'); }

            const property = this.getProperty(parsed.expression, parsed.sessionName);
            ErrorMessage.throwIfError(property);

            //await waitForState(property.value.state, s => s === 'upToDate', s => s === 'error');
            await waitForState(property.value.state, s => s === 'upToDate');

            const value = property.value.value.get();
            return value;
        }
    }));

    private readonly _properties = new Map<string, RefCounted<IProperty>>();

    private getProperty(expression: string, debugSessionName: string | undefined): RefCounted<IProperty> | ErrorMessage {
        const key = JSON.stringify({ expression, debugSessionName: debugSessionName ?? undefined });
        let property = this._properties.get(key);
        if (!property) {
            property = RefCounted.ofWeak(this._activeSessionPropertyFactory.createActiveContextProperty(expression, debugSessionName), {
                dispose: () => {
                    this._properties.delete(key);
                }
            });
            /*if (property.value.state.get() === 'noSession') {
                property.dispose();
                return new ErrorMessage('No active debug session');
            }*/
            this._properties.set(key, property);
        }
        return property;
    }

    public async editProperty(expression: string, debugSessionName: string | undefined, label: string | undefined, viewColumn = ViewColumn.Beside): Promise<void | ErrorMessage> {
        const property = this.getProperty(expression, debugSessionName);
        if (ErrorMessage.isErr(property)) {
            return property;
        }
        property.value.refresh();
        const s = await waitForState(property.value.state, s => s !== 'updating' && s !== 'initializing');
        switch (s) {
            case 'error':
                return new ErrorMessage(property.value.error.get()!);
            case 'noSession':
                return new ErrorMessage('No active debug session');
        }
        const uri = getUri(expression, debugSessionName, property.value.fileExtension.get(), label);
        await showDocument(uri, viewColumn);
    }
}

function isDefined<T>(value: T | undefined): value is T {
    return value !== undefined;
}

const scheme = 'debug-value';

function parseUri(uri: Uri): { expression: string, sessionName: string | undefined } | undefined {
    if (uri.scheme !== scheme) { return undefined; }

    const data = JSON.parse(uri.query) as { expression: string, sessionName: string | undefined };

    return { expression: data.expression, sessionName: data.sessionName ?? undefined };
}

function getUri(expression: string, sessionName: string | undefined, extension: string | undefined, title: string | undefined): Uri {
    let path = (title ?? expression)
        .replaceAll('_', '.')
        .replaceAll(/[/\\]|(\.\.+)/g, '_');
    if (extension !== undefined) {
        path = `${path}.${extension}`;
    }
    return Uri.from({ scheme, path: `/${path}`, query: JSON.stringify({ expression, sessionName }) });
}

function inputToUris(input: InputType | unknown): Uri[] {
    const i = input as any;
    if (typeof i === 'object' && 'uri' in i) {
        return [i.uri];
    }
    return [];
}

type InputType = TabInputText | TabInputTextDiff | TabInputCustom | TabInputWebview | TabInputNotebook | TabInputNotebookDiff | TabInputTerminal;

export class SessionInformation {
    constructor(
        public readonly session: DebugSessionProxy,
        public readonly properties: IObservable<PropertyInformation[]>,
    ) { }

    public readonly hasProperties = derived(this, reader => this.properties.read(reader).length > 0);
}
