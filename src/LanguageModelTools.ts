import { CancellationToken, lm, LanguageModelTool, LanguageModelToolInvocationOptions, LanguageModelToolResult, LanguageModelTextPart } from "vscode";
import { DebugSessionService } from "./debugService/DebugSessionService";
import { Disposable } from "./utils/disposables";

export class LanguageModelTools extends Disposable {
	constructor(private readonly _debugSessionService: DebugSessionService) {
		super();

		this._register(lm.registerTool('listDebugSessions', new ListDebugSessionsTool(this._debugSessionService)));
		this._register(lm.registerTool('evaluateExpressionInDebugSession', new EvaluateExpressionTool(this._debugSessionService)));
	}
}

class ListDebugSessionsTool implements LanguageModelTool<{}> {
	constructor(private readonly debugSessionService: DebugSessionService) { }

	async invoke(options: LanguageModelToolInvocationOptions<{}>, token: CancellationToken): Promise<LanguageModelToolResult> {
		try {
			const sessions = this.debugSessionService.debugSessions.get();
			const result = sessions.map(sessionProxy => ({
				id: sessionProxy.numericId,
				name: sessionProxy.session.name,
				expressionLanguageId: this._getExpressionLanguageId(sessionProxy.session.type),
				isActive: sessionProxy === this.debugSessionService.activeSession.get(),
			}));
			return new LanguageModelToolResult([new LanguageModelTextPart(JSON.stringify(result, null, 2))]);
		} catch (error) {
			return new LanguageModelToolResult([
				new LanguageModelTextPart(JSON.stringify({ error: `Failed to list debug sessions: ${error}` }, null, 2))
			]);
		}
	}

	private _getExpressionLanguageId(debugType: string): string {
		switch (debugType) {
			case 'node':
			case 'pwa-node':
			case 'pwa-chrome':
			case 'chrome':
				return 'javascript';
			case 'python':
				return 'python';
			case 'csharp':
			case 'coreclr':
				return 'csharp';
			case 'go':
				return 'go';
			case 'java':
				return 'java';
			case 'cpp':
			case 'cppdbg':
				return 'cpp';
			default:
				return 'unknown';
		}
	}
}

interface EvaluateExpressionInput {
	debugSessionId: number;
	expression: string;
}

class EvaluateExpressionTool implements LanguageModelTool<EvaluateExpressionInput> {
	constructor(private readonly debugSessionService: DebugSessionService) { }

	async invoke(options: LanguageModelToolInvocationOptions<EvaluateExpressionInput>, token: CancellationToken): Promise<LanguageModelToolResult> {
		const { debugSessionId, expression } = options.input;

		const sessions = this.debugSessionService.debugSessions.get();
		const targetSession = sessions.find(sessionProxy => sessionProxy.numericId === debugSessionId);

		if (!targetSession) {
			return new LanguageModelToolResult([
				new LanguageModelTextPart(JSON.stringify({ error: `Debug session with ID ${debugSessionId} not found` }, null, 2))
			]);
		}

		const frameId = targetSession.pausedStackFrameId.get();

		try {
			const evalResult = await targetSession.evaluate({ expression, frameId, context: 'repl' });

			return new LanguageModelToolResult([
				new LanguageModelTextPart(JSON.stringify({ value: evalResult.result }, null, 2))
			]);
		} catch (error) {
			return new LanguageModelToolResult([
				new LanguageModelTextPart(JSON.stringify({ error: `Failed to evaluate expression: ${error}` }, null, 2))
			]);
		}
	}
}
