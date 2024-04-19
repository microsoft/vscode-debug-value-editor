import { TextDocument, workspace } from "vscode";
import { TextDocumentEditor } from "./TextDocumentEditor";
import { Disposable } from "./utils/disposables";
import { IObservable, autorun } from "./utils/observables/observable";

export class SyncedTextDocument extends Disposable {
    private _value: string;

    private _editor = new TextDocumentEditor(this._textDocument.uri, () => {
        this._updateValue();
    });

    constructor(
        private readonly _textDocument: TextDocument,
        private readonly _source: IDocumentSource,
    ) {
        super();

        this._register(workspace.onDidChangeTextDocument(e => {
            if (e.document !== _textDocument) { return; }
            this._textDocument.save();
            // Ignore the echo of us applying a change
            if (this._editor.isUpdating) { return; }
            this._updateValue();
        }));

        this._value = _textDocument.getText();

        this._register(
            autorun(reader => {
                /** @description Update text document */
                this._setValue(_source.value.read(reader));
            })
        );
    }

    private _updateValue() {
        const text = this._textDocument.getText();
        if (this._value === text) { return; }
        this._value = text;
        this._source.setValue(this._value);
    }

    private _setValue(value: string) {
        if (toLF(this._value).trim() === toLF(value).trim()) {
            return;
        }
        this._value = value;
        this._editor.setValue(value);
    }
}

function toLF(str: string): string {
    return str.replace(/\r\n/g, "\n");
}

export interface IDocumentSource {
    readonly value: IObservable<string>;
    setValue(newValue: string): void;
}
