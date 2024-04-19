import { Range, Uri, WorkspaceEdit, workspace } from "vscode";

export class TextDocumentEditor {
    private _nextOperation: { value: string, getRange?: () => Range } | undefined = undefined;

    public isUpdating = false;

    constructor(
        public readonly uri: Uri,
        private readonly _queueFinished: () => void,
    ) { }

    setValue(value: string, getRange?: () => Range): void {
        this._nextOperation = { value, getRange };
        this._startQueueIfNotActive();
    }

    private _promise: Promise<void> | undefined;

    private _startQueueIfNotActive() {
        if (this._promise) { return; }
        this._promise = this._processQueue();
    }

    private async _processQueue(): Promise<void> {
        while (this._nextOperation !== undefined) {
            const { value, getRange } = this._nextOperation;
            this._nextOperation = undefined;

            const range = getRange ? getRange() : new Range(0, 0, Number.MAX_VALUE, Number.MAX_VALUE);
            const e = new WorkspaceEdit();
            e.replace(this.uri, range, value);
            this.isUpdating = true;
            let successful: boolean;
            try {
                successful = await workspace.applyEdit(e);
            } finally {
                this.isUpdating = false;
            }
            if (!successful) {
                if (!this._nextOperation) {
                    this._nextOperation = { value, getRange };
                }
                continue;
            }
        }

        this._promise = undefined;

        this._queueFinished();
    }
}
