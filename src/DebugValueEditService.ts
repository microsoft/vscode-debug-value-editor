import { TabInputCustom, TabInputNotebook, TabInputNotebookDiff, TabInputTerminal, TabInputText, TabInputTextDiff, TabInputWebview, Uri, ViewColumn, window, workspace } from "vscode";
import { SyncedTextDocument } from "./VirtualDocument";
import { registerVirtualFs } from "./VirtualFileSystemController";
import { DebugSessionService } from "./debugService/DebugSessionService";
import { ActiveSessionPropertyFactory, IProperty } from "./debugService/debugService";
import { JsDebugSessionPropertyFactory } from "./debugService/JsDebugSessionPropertyFactory";
import { Disposable, RefCounted } from "./utils/disposables";
import { derived, derivedObservableWithCache, observableFromEvent, waitForState } from "./utils/observables/observable";
import { mapObservableArrayCached } from "./utils/observables/observableInternal/utils";
import { ErrorMessage, showDocument } from "./utils/utils";
import { toDisposable } from "./utils/observables/observableInternal/lifecycle";

export class DebugValueEditorService extends Disposable {
    private readonly _debugSessionService = this._register(new DebugSessionService());
    private readonly _propertyFactory = this._register(new JsDebugSessionPropertyFactory());
    private readonly _debugService = this._register(new ActiveSessionPropertyFactory(this._debugSessionService, this._propertyFactory));

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

        const property = this.getProperty(parsed.expression);

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

    constructor() {
        super();

        this._syncedTextDocuments.recomputeInitiallyAndOnChange(this._store)
    }

    private readonly _fs = this._register(registerVirtualFs({
        scheme: scheme,
        getInitialContent: async uri => {
            const parsed = parseUri(uri);
            if (!parsed) { throw new Error('invalid uri'); }

            const property = this.getProperty(parsed.expression);
            ErrorMessage.throwIfError(property);

            //await waitForState(property.value.state, s => s === 'upToDate', s => s === 'error');
            await waitForState(property.value.state, s => s === 'upToDate');

            const value = property.value.value.get();
            return value;
        }
    }));

    private getProperty(expression: string): RefCounted<IProperty> | ErrorMessage {
        let property = this._propertyPerExpression.get(expression);
        if (!property) {
            property = RefCounted.ofWeak(this._debugService.createActiveContextProperty(expression), {
                dispose: () => {
                    this._propertyPerExpression.delete(expression);
                }
            });
            /*if (property.value.state.get() === 'noSession') {
                property.dispose();
                return new ErrorMessage('No active debug session');
            }*/
            this._propertyPerExpression.set(expression, property);
        }
        return property;
    }

    private readonly _propertyPerExpression = new Map<string, RefCounted<IProperty>>();

    public async editProperty(expression: string, viewColumn = ViewColumn.Beside): Promise<void | ErrorMessage> {
        const property = this.getProperty(expression);
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
        const uri = getUri(expression, property.value.fileExtension.get());
        await showDocument(uri, viewColumn);
    }
}

const scheme = 'debug-value';

function parseUri(uri: Uri): { expression: string } | undefined {
    if (uri.scheme !== scheme) { return undefined; }

    const expression = uri.query;

    return { expression };
}

function getUri(expression: string, extension?: string): Uri {
    let path: string;
    if (extension !== undefined) {
        path = `${expression}.${extension}`;
    } else {
        path = expression.replaceAll('_', '.');
    }
    return Uri.from({ scheme, path: `/${path}`, query: expression });
}

function inputToUris(input: InputType | unknown): Uri[] {
    const i = input as any;
    if (typeof i === 'object' && 'uri' in i) {
        return [i.uri];
    }
    return [];
}

type InputType = TabInputText | TabInputTextDiff | TabInputCustom | TabInputWebview | TabInputNotebook | TabInputNotebookDiff | TabInputTerminal;