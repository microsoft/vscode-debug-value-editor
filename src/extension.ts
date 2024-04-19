import { ExtensionContext, ViewColumn, commands } from "vscode";
import { OpenPropertyCodeLensFeature } from "./CodeLensFeature";
import { DebugValueEditorService } from "./DebugValueEditService";
import { Disposable } from "./utils/disposables";
import { ErrorMessage } from "./utils/utils";

export const editPropertyCommandId = 'debug-value-editor.edit-property';

export class Extension extends Disposable {
	private readonly _debugValueEditService = this._register(new DebugValueEditorService());

	constructor(context: ExtensionContext) {
		super();

		this._register(new OpenPropertyCodeLensFeature());
		this._register(
			commands.registerCommand(editPropertyCommandId, async (args: { expressions: string[] }) => {
				const expressions = args.expressions;
				let first = true;
				for (const expression of expressions) {
					if (!first) {
						await commands.executeCommand('workbench.action.newGroupBelow');
					}
					const result = await this._debugValueEditService.editProperty(expression, first ? ViewColumn.Beside : ViewColumn.Active);
					if (ErrorMessage.showIfError(result)) {
						return;
					}
					first = false;
				}
			})
		);
	}
}

export function activate(context: ExtensionContext) {
	context.subscriptions.push(new Extension(context));
}
