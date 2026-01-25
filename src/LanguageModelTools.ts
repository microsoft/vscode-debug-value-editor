import { CancellationToken, debug, DebugConfiguration, lm, LanguageModelTool, LanguageModelToolInvocationOptions, LanguageModelToolResult, LanguageModelTextPart, LanguageModelDataPart } from "vscode";
import { DebugSessionService, DebugSessionProxy, StackFrame } from "./debugService/DebugSessionService";
import { Disposable } from "./utils/disposables";
import { waitForCondition, getLineContext, wait } from "./utils/utils";
import { JsDebugSupport } from "./debugService/JsDebugSupport";

// ============================================================================
// Shared Types
// ============================================================================

interface PendingEvaluation {
	promise: Promise<{ result: string; variablesReference: number }>;
	debugSessionId: string;
	expression: string;
	createdAt: Date;
}

interface DebugSessionNode {
	debugSessionId: string;
	name: string;
	expressionLanguageId: string;
	isActive: boolean;
	children: DebugSessionNode[];
}

interface StopLocation {
	file: string;
	line: number;
	column: number;
	functionName: string;
	lineContext: string;
}

// ============================================================================
// Shared Utilities
// ============================================================================

function getExpressionLanguageId(debugType: string): string {
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

function buildSessionHierarchy(sessions: DebugSessionProxy[], activeSession: DebugSessionProxy | undefined): DebugSessionNode[] {
	const nodeMap = new Map<string, DebugSessionNode>();
	for (const s of sessions) {
		nodeMap.set(s.session.id, {
			debugSessionId: s.formattedId,
			name: s.session.name,
			expressionLanguageId: getExpressionLanguageId(s.session.type),
			isActive: s === activeSession,
			children: [],
		});
	}

	const roots: DebugSessionNode[] = [];
	for (const s of sessions) {
		const node = nodeMap.get(s.session.id)!;
		const parentSession = s.session.parentSession;
		if (parentSession && nodeMap.has(parentSession.id)) {
			nodeMap.get(parentSession.id)!.children.push(node);
		} else {
			roots.push(node);
		}
	}

	return roots;
}

function formatSessionHierarchy(debugSessionService: DebugSessionService): DebugSessionNode[] {
	const sessions = debugSessionService.debugSessions.get();
	const activeSession = debugSessionService.activeSession.get();
	return buildSessionHierarchy(sessions, activeSession);
}

function getSessionWithHierarchy(debugSessionService: DebugSessionService, targetSession: DebugSessionProxy): DebugSessionNode | null {
	const sessions = debugSessionService.debugSessions.get();
	const activeSession = debugSessionService.activeSession.get();
	const hierarchy = buildSessionHierarchy(sessions, activeSession);

	// Find the target session in the hierarchy (it could be a root or nested)
	function findInHierarchy(nodes: DebugSessionNode[]): DebugSessionNode | null {
		for (const node of nodes) {
			if (node.debugSessionId === targetSession.formattedId) {
				return node;
			}
			const found = findInHierarchy(node.children);
			if (found) {
				return found;
			}
		}
		return null;
	}

	return findInHierarchy(hierarchy);
}

function findSessionByFormattedId(sessions: DebugSessionProxy[], formattedId: string): DebugSessionProxy | undefined {
	return sessions.find(s => s.formattedId === formattedId);
}

function jsonResult(data: unknown): LanguageModelToolResult {
	return new LanguageModelToolResult([new LanguageModelTextPart(JSON.stringify(data, null, 2))]);
}

function sessionNotFoundResult(debugSessionService: DebugSessionService, debugSessionId: string): LanguageModelToolResult {
	return jsonResult({
		error: `Debug session with ID "${debugSessionId}" not found or has ended`,
		availableSessions: formatSessionHierarchy(debugSessionService),
	});
}

async function getStopLocationWithContext(session: DebugSessionProxy, threadId: number): Promise<StopLocation | null> {
	const stackTrace = await session.getStackTrace({ threadId, levels: 1 });
	if (stackTrace.stackFrames.length === 0) {
		return null;
	}

	const topFrame = stackTrace.stackFrames[0];
	if (!topFrame.source?.path) {
		return null;
	}

	const contextResult = await getLineContext(topFrame.source.path, topFrame.line);
	const lineContext = 'error' in contextResult ? `Error: ${contextResult.error}` : contextResult.lineContext;

	return {
		file: topFrame.source.path,
		line: topFrame.line,
		column: topFrame.column,
		functionName: topFrame.name,
		lineContext,
	};
}

async function executeStepAndWaitForPause(
	session: DebugSessionProxy,
	stepFn: (threadId: number) => Promise<void>,
	waitMs = 500
): Promise<{ stopped: true; location: StopLocation } | { stopped: false; reason: string }> {
	const threads = await session.getThreads();
	if (threads.length === 0) {
		return { stopped: false, reason: 'No threads available' };
	}

	const threadId = threads[0].id;

	// Check if paused
	const frameIdBefore = session.pausedStackFrameId.get();
	if (frameIdBefore === undefined) {
		return { stopped: false, reason: 'Debug session is not paused. Cannot step.' };
	}

	await stepFn(threadId);

	// Wait for the debugger to pause again
	const newFrameId = await waitForCondition(
		() => {
			const frameId = session.pausedStackFrameId.get();
			// Wait until we get a new frame (different from before, or same if single-step)
			return frameId !== undefined ? frameId : undefined;
		},
		waitMs,
		50
	);

	if (newFrameId === undefined) {
		return { stopped: false, reason: `Debugger did not pause within ${waitMs}ms. Program may still be running.` };
	}

	const location = await getStopLocationWithContext(session, threadId);
	if (!location) {
		return { stopped: false, reason: 'Could not determine stop location' };
	}

	return { stopped: true, location };
}

// ============================================================================
// Main Class
// ============================================================================

export class LanguageModelTools extends Disposable {
	private readonly _pendingEvaluations = new Map<string, PendingEvaluation>();
	private _nextRequestId = 1;

	constructor(
		private readonly _debugSessionService: DebugSessionService,
		private readonly _jsDebugSupport: JsDebugSupport,
	) {
		super();

		// Session management tools
		this._register(lm.registerTool('listDebugSessions', new ListDebugSessionsTool(this._debugSessionService)));
		this._register(lm.registerTool('startDebugSession', new StartDebugSessionTool(this._debugSessionService)));
		this._register(lm.registerTool('launchNodeProgram', new LaunchNodeProgramTool(this._debugSessionService)));
		this._register(lm.registerTool('launchNodeRepl', new LaunchNodeReplTool(this._debugSessionService)));
		this._register(lm.registerTool('launchDenoRepl', new LaunchDenoReplTool(this._debugSessionService)));
		this._register(lm.registerTool('stopDebugSession', new StopDebugSessionTool(this._debugSessionService)));
		this._register(lm.registerTool('restartDebugSession', new RestartDebugSessionTool(this._debugSessionService)));

		// Evaluation tools
		this._register(lm.registerTool('evaluateExpressionInDebugSession', new EvaluateExpressionTool(this._debugSessionService, this._pendingEvaluations, () => this._nextRequestId++)));
		this._register(lm.registerTool('getEvaluationResult', new GetEvaluationResultTool(this._debugSessionService, this._pendingEvaluations)));

		// Stepping tools
		this._register(lm.registerTool('stepInto', new StepIntoTool(this._debugSessionService)));
		this._register(lm.registerTool('stepOver', new StepOverTool(this._debugSessionService)));
		this._register(lm.registerTool('stepOut', new StepOutTool(this._debugSessionService)));
		this._register(lm.registerTool('runToLine', new RunToLineTool(this._debugSessionService)));

		// Inspection tools
		this._register(lm.registerTool('getStackTrace', new GetStackTraceTool(this._debugSessionService)));
		this._register(lm.registerTool('getLocalVariables', new GetLocalVariablesTool(this._debugSessionService)));
		this._register(lm.registerTool('getLineContext', new GetLineContextTool()));

		// Breakpoint tools
		this._register(lm.registerTool('setBreakpoint', new SetBreakpointTool(this._debugSessionService)));

		// DOM tools
		this._register(lm.registerTool('captureDomNodeScreenshot', new CaptureDomNodeScreenshotTool(this._debugSessionService, this._jsDebugSupport)));

		// Script exploration tools
		this._register(lm.registerTool('getLoadedScripts', new GetLoadedScriptsTool(this._debugSessionService, this._jsDebugSupport)));
		this._register(lm.registerTool('getScriptSource', new GetScriptSourceTool(this._debugSessionService, this._jsDebugSupport)));

		// Low-level CDP tool
		this._register(lm.registerTool('cdpRequest', new CdpRequestTool(this._debugSessionService, this._jsDebugSupport)));
	}
}

// ============================================================================
// Session Management Tools
// ============================================================================

class ListDebugSessionsTool implements LanguageModelTool<{}> {
	constructor(private readonly _debugSessionService: DebugSessionService) { }

	async invoke(_options: LanguageModelToolInvocationOptions<{}>, _token: CancellationToken): Promise<LanguageModelToolResult> {
		try {
			const hierarchy = formatSessionHierarchy(this._debugSessionService);
			return jsonResult(hierarchy);
		} catch (error) {
			return jsonResult({ error: `Failed to list debug sessions: ${error}` });
		}
	}
}

interface StartDebugSessionInput {
	configuration: DebugConfiguration;
}

class StartDebugSessionTool implements LanguageModelTool<StartDebugSessionInput> {
	constructor(private readonly _debugSessionService: DebugSessionService) { }

	async invoke(options: LanguageModelToolInvocationOptions<StartDebugSessionInput>, _token: CancellationToken): Promise<LanguageModelToolResult> {
		const { configuration } = options.input;

		// Validate required fields
		if (!configuration.type) {
			return jsonResult({ error: 'Debug configuration must have a "type" property (e.g., "pwa-node", "pwa-chrome", "python")' });
		}
		if (!configuration.request) {
			return jsonResult({ error: 'Debug configuration must have a "request" property ("launch" or "attach")' });
		}

		try {
			const existingSessionsBefore = new Set(
				this._debugSessionService.debugSessions.get().map(s => s.session.id)
			);

			// Ensure a name is set
			const configWithName: DebugConfiguration = {
				...configuration,
				name: configuration.name || `${configuration.type}: ${configuration.request}`,
			};

			const started = await debug.startDebugging(undefined, configWithName);

			if (!started) {
				return jsonResult({ error: 'Failed to start debug session. Check the debug configuration.' });
			}

			const newSession = await waitForCondition(
				() => this._findNewSession(existingSessionsBefore),
				5000
			);

			if (!newSession) {
				return jsonResult({ error: 'Debug session started but could not retrieve session ID' });
			}

			const sessionHierarchy = getSessionWithHierarchy(this._debugSessionService, newSession);

			return jsonResult({
				debugSessionId: newSession.formattedId,
				name: newSession.session.name,
				type: newSession.session.type,
				session: sessionHierarchy,
			});
		} catch (error) {
			return jsonResult({ error: `Failed to start debug session: ${error}` });
		}
	}

	private _findNewSession(existingSessionIds: Set<string>): DebugSessionProxy | undefined {
		const sessions = this._debugSessionService.debugSessions.get();
		return sessions.find(s => !existingSessionIds.has(s.session.id));
	}
}

interface LaunchNodeProgramInput {
	program: string;
	args?: string[];
	stopOnEntry?: boolean;
	cwd?: string;
}

class LaunchNodeProgramTool implements LanguageModelTool<LaunchNodeProgramInput> {
	constructor(private readonly _debugSessionService: DebugSessionService) { }

	async invoke(options: LanguageModelToolInvocationOptions<LaunchNodeProgramInput>, _token: CancellationToken): Promise<LanguageModelToolResult> {
		const { program, args = [], stopOnEntry = false, cwd } = options.input;

		try {
			const existingSessionsBefore = new Set(
				this._debugSessionService.debugSessions.get().map(s => s.session.id)
			);

			const debugConfig: DebugConfiguration = {
				type: 'pwa-node',
				request: 'launch',
				name: `Node: ${program}`,
				program,
				args,
				stopOnEntry,
				cwd,
				skipFiles: ['<node_internals>/**'],
			};

			const started = await debug.startDebugging(undefined, debugConfig);

			if (!started) {
				return jsonResult({ error: 'Failed to start debug session' });
			}

			const newSession = await waitForCondition(
				() => this._findNewSession(existingSessionsBefore),
				5000
			);

			if (!newSession) {
				return jsonResult({ error: 'Debug session started but could not retrieve session ID' });
			}

			const sessionHierarchy = getSessionWithHierarchy(this._debugSessionService, newSession);

			return jsonResult({
				debugSessionId: newSession.formattedId,
				name: newSession.session.name,
				session: sessionHierarchy,
			});
		} catch (error) {
			return jsonResult({ error: `Failed to launch debug session: ${error}` });
		}
	}

	private _findNewSession(existingSessionIds: Set<string>): DebugSessionProxy | undefined {
		const sessions = this._debugSessionService.debugSessions.get();
		return sessions.find(s => !existingSessionIds.has(s.session.id));
	}
}

interface LaunchNodeReplInput {
	cwd?: string;
}

class LaunchNodeReplTool implements LanguageModelTool<LaunchNodeReplInput> {
	constructor(private readonly _debugSessionService: DebugSessionService) { }

	async invoke(options: LanguageModelToolInvocationOptions<LaunchNodeReplInput>, _token: CancellationToken): Promise<LanguageModelToolResult> {
		const { cwd } = options.input;

		try {
			const existingSessionsBefore = new Set(
				this._debugSessionService.debugSessions.get().map(s => s.session.id)
			);

			const debugConfig: DebugConfiguration = {
				type: 'pwa-node',
				request: 'launch',
				name: 'Node REPL',
				runtimeArgs: ['--interactive'],
				cwd,
				skipFiles: ['<node_internals>/**'],
			};

			const started = await debug.startDebugging(undefined, debugConfig);

			if (!started) {
				return jsonResult({ error: 'Failed to start Node REPL session' });
			}

			const newSession = await waitForCondition(
				() => this._findNewSession(existingSessionsBefore),
				5000
			);

			if (!newSession) {
				return jsonResult({ error: 'Node REPL session started but could not retrieve session ID' });
			}

			const sessionHierarchy = getSessionWithHierarchy(this._debugSessionService, newSession);

			return jsonResult({
				debugSessionId: newSession.formattedId,
				name: newSession.session.name,
				session: sessionHierarchy,
			});
		} catch (error) {
			return jsonResult({ error: `Failed to launch Node REPL: ${error}` });
		}
	}

	private _findNewSession(existingSessionIds: Set<string>): DebugSessionProxy | undefined {
		const sessions = this._debugSessionService.debugSessions.get();
		return sessions.find(s => !existingSessionIds.has(s.session.id));
	}
}

interface LaunchDenoReplInput {
	cwd?: string;
}

class LaunchDenoReplTool implements LanguageModelTool<LaunchDenoReplInput> {
	constructor(private readonly _debugSessionService: DebugSessionService) { }

	async invoke(options: LanguageModelToolInvocationOptions<LaunchDenoReplInput>, _token: CancellationToken): Promise<LanguageModelToolResult> {
		const { cwd } = options.input;

		try {
			const existingSessionsBefore = new Set(
				this._debugSessionService.debugSessions.get().map(s => s.session.id)
			);

			const debugConfig: DebugConfiguration = {
				type: 'pwa-node',
				request: 'launch',
				name: 'Deno REPL',
				runtimeExecutable: 'deno',
				runtimeArgs: ['repl', '-A'],
				attachSimplePort: 9229,
				cwd,
				skipFiles: ['<node_internals>/**'],
			};

			const started = await debug.startDebugging(undefined, debugConfig);

			if (!started) {
				return jsonResult({ 
					error: 'Failed to start Deno REPL session. Make sure Deno is installed (https://deno.land/). You can install it via: irm https://deno.land/install.ps1 | iex (Windows) or curl -fsSL https://deno.land/install.sh | sh (Linux/macOS)' 
				});
			}

			const newSession = await waitForCondition(
				() => this._findNewSession(existingSessionsBefore),
				5000
			);

			if (!newSession) {
				return jsonResult({ error: 'Deno REPL session started but could not retrieve session ID' });
			}

			const sessionHierarchy = getSessionWithHierarchy(this._debugSessionService, newSession);

			return jsonResult({
				debugSessionId: newSession.formattedId,
				name: newSession.session.name,
				session: sessionHierarchy,
				tip: 'Deno REPL supports npm packages via "import" and auto-fetches them. Example: const _ = await import("npm:lodash"); _.chunk([1,2,3,4], 2)',
			});
		} catch (error) {
			return jsonResult({ error: `Failed to launch Deno REPL: ${error}` });
		}
	}

	private _findNewSession(existingSessionIds: Set<string>): DebugSessionProxy | undefined {
		const sessions = this._debugSessionService.debugSessions.get();
		return sessions.find(s => !existingSessionIds.has(s.session.id));
	}
}

interface StopDebugSessionInput {
	debugSessionId: string;
}

class StopDebugSessionTool implements LanguageModelTool<StopDebugSessionInput> {
	constructor(private readonly _debugSessionService: DebugSessionService) { }

	async invoke(options: LanguageModelToolInvocationOptions<StopDebugSessionInput>, _token: CancellationToken): Promise<LanguageModelToolResult> {
		const { debugSessionId } = options.input;

		const sessions = this._debugSessionService.debugSessions.get();
		const targetSession = findSessionByFormattedId(sessions, debugSessionId);

		if (!targetSession) {
			return sessionNotFoundResult(this._debugSessionService, debugSessionId);
		}

		try {
			await debug.stopDebugging(targetSession.session);
			return jsonResult({
				success: true,
				message: `Debug session "${targetSession.session.name}" stopped`,
			});
		} catch (error) {
			return jsonResult({ error: `Failed to stop debug session: ${error}` });
		}
	}
}

interface RestartDebugSessionInput {
	debugSessionId: string;
}

class RestartDebugSessionTool implements LanguageModelTool<RestartDebugSessionInput> {
	constructor(private readonly _debugSessionService: DebugSessionService) { }

	async invoke(options: LanguageModelToolInvocationOptions<RestartDebugSessionInput>, _token: CancellationToken): Promise<LanguageModelToolResult> {
		const { debugSessionId } = options.input;

		const sessions = this._debugSessionService.debugSessions.get();
		const targetSession = findSessionByFormattedId(sessions, debugSessionId);

		if (!targetSession) {
			return sessionNotFoundResult(this._debugSessionService, debugSessionId);
		}

		try {
			const existingSessionsBefore = new Set(
				this._debugSessionService.debugSessions.get().map(s => s.session.id)
			);

			const configuration = targetSession.session.configuration;
			await debug.stopDebugging(targetSession.session);

			await wait(500);

			const started = await debug.startDebugging(undefined, configuration as DebugConfiguration);

			if (!started) {
				return jsonResult({ error: 'Failed to restart debug session' });
			}

			const newSession = await waitForCondition(
				() => {
					const currentSessions = this._debugSessionService.debugSessions.get();
					return currentSessions.find(s => !existingSessionsBefore.has(s.session.id) && s.session.id !== targetSession.session.id);
				},
				5000
			);

			if (!newSession) {
				return jsonResult({ error: 'Debug session restarted but could not retrieve new session ID' });
			}

			const sessionHierarchy = getSessionWithHierarchy(this._debugSessionService, newSession);

			return jsonResult({
				debugSessionId: newSession.formattedId,
				name: newSession.session.name,
				session: sessionHierarchy,
				message: 'Debug session restarted successfully',
			});
		} catch (error) {
			return jsonResult({ error: `Failed to restart debug session: ${error}` });
		}
	}
}

// ============================================================================
// Evaluation Tools
// ============================================================================

interface EvaluateExpressionInput {
	debugSessionId: string;
	expression: string;
	timeoutMs?: number;
}

class EvaluateExpressionTool implements LanguageModelTool<EvaluateExpressionInput> {
	constructor(
		private readonly _debugSessionService: DebugSessionService,
		private readonly _pendingEvaluations: Map<string, PendingEvaluation>,
		private readonly _getNextRequestId: () => number,
	) { }

	async invoke(options: LanguageModelToolInvocationOptions<EvaluateExpressionInput>, _token: CancellationToken): Promise<LanguageModelToolResult> {
		const { debugSessionId, expression, timeoutMs = 1000 } = options.input;

		const sessions = this._debugSessionService.debugSessions.get();
		const targetSession = findSessionByFormattedId(sessions, debugSessionId);

		if (!targetSession) {
			return sessionNotFoundResult(this._debugSessionService, debugSessionId);
		}

		const frameId = targetSession.pausedStackFrameId.get();

		try {
			const evalPromise = targetSession.evaluate({ expression, frameId, context: 'repl' });

			const result = await Promise.race([
				evalPromise.then(r => ({ type: 'success' as const, value: r })),
				new Promise<{ type: 'timeout' }>((resolve) =>
					setTimeout(() => resolve({ type: 'timeout' }), timeoutMs)
				),
			]);

			if (result.type === 'success') {
				return jsonResult({ value: result.value.result });
			}

			const requestId = `eval-${this._getNextRequestId()}`;
			this._pendingEvaluations.set(requestId, {
				promise: evalPromise,
				debugSessionId: debugSessionId,
				expression,
				createdAt: new Date(),
			});

			return jsonResult({
				pending: true,
				requestId,
				message: `Evaluation timed out after ${timeoutMs}ms. Use getEvaluationResult with this requestId to check the result later.`,
			});
		} catch (error) {
			const currentSessions = this._debugSessionService.debugSessions.get();
			const stillExists = findSessionByFormattedId(currentSessions, debugSessionId);
			if (!stillExists) {
				return sessionNotFoundResult(this._debugSessionService, debugSessionId);
			}

			return jsonResult({ error: `Failed to evaluate expression: ${error}` });
		}
	}
}

interface GetEvaluationResultInput {
	requestId: string;
	timeoutMs?: number;
}

class GetEvaluationResultTool implements LanguageModelTool<GetEvaluationResultInput> {
	constructor(
		private readonly _debugSessionService: DebugSessionService,
		private readonly _pendingEvaluations: Map<string, PendingEvaluation>,
	) { }

	async invoke(options: LanguageModelToolInvocationOptions<GetEvaluationResultInput>, _token: CancellationToken): Promise<LanguageModelToolResult> {
		const { requestId, timeoutMs = 1000 } = options.input;

		const pending = this._pendingEvaluations.get(requestId);
		if (!pending) {
			return jsonResult({
				error: `Request ID "${requestId}" not found. It may have expired or never existed.`,
			});
		}

		const sessions = this._debugSessionService.debugSessions.get();
		const sessionStillExists = sessions.some(s => s.formattedId === pending.debugSessionId);
		if (!sessionStillExists) {
			this._pendingEvaluations.delete(requestId);
			return jsonResult({
				error: `Debug session "${pending.debugSessionId}" has ended`,
				availableSessions: formatSessionHierarchy(this._debugSessionService),
			});
		}

		try {
			const result = await Promise.race([
				pending.promise.then(r => ({ type: 'success' as const, value: r })),
				new Promise<{ type: 'timeout' }>((resolve) =>
					setTimeout(() => resolve({ type: 'timeout' }), timeoutMs)
				),
			]);

			if (result.type === 'success') {
				this._pendingEvaluations.delete(requestId);
				return jsonResult({ value: result.value.result });
			}

			return jsonResult({
				pending: true,
				requestId,
				message: `Evaluation still pending after ${timeoutMs}ms. Try again later.`,
			});
		} catch (error) {
			this._pendingEvaluations.delete(requestId);

			const currentSessions = this._debugSessionService.debugSessions.get();
			const stillExists = currentSessions.some(s => s.formattedId === pending.debugSessionId);
			if (!stillExists) {
				return jsonResult({
					error: `Debug session "${pending.debugSessionId}" has ended`,
					availableSessions: formatSessionHierarchy(this._debugSessionService),
				});
			}

			return jsonResult({ error: `Evaluation failed: ${error}` });
		}
	}
}

// ============================================================================
// Stepping Tools
// ============================================================================

interface DebugSessionIdInput {
	debugSessionId: string;
}

class StepIntoTool implements LanguageModelTool<DebugSessionIdInput> {
	constructor(private readonly _debugSessionService: DebugSessionService) { }

	async invoke(options: LanguageModelToolInvocationOptions<DebugSessionIdInput>, _token: CancellationToken): Promise<LanguageModelToolResult> {
		const { debugSessionId } = options.input;

		const sessions = this._debugSessionService.debugSessions.get();
		const targetSession = findSessionByFormattedId(sessions, debugSessionId);

		if (!targetSession) {
			return sessionNotFoundResult(this._debugSessionService, debugSessionId);
		}

		try {
			const result = await executeStepAndWaitForPause(
				targetSession,
				(threadId) => targetSession.stepIn(threadId)
			);
			return jsonResult(result);
		} catch (error) {
			return jsonResult({ error: `Failed to step into: ${error}` });
		}
	}
}

class StepOverTool implements LanguageModelTool<DebugSessionIdInput> {
	constructor(private readonly _debugSessionService: DebugSessionService) { }

	async invoke(options: LanguageModelToolInvocationOptions<DebugSessionIdInput>, _token: CancellationToken): Promise<LanguageModelToolResult> {
		const { debugSessionId } = options.input;

		const sessions = this._debugSessionService.debugSessions.get();
		const targetSession = findSessionByFormattedId(sessions, debugSessionId);

		if (!targetSession) {
			return sessionNotFoundResult(this._debugSessionService, debugSessionId);
		}

		try {
			const result = await executeStepAndWaitForPause(
				targetSession,
				(threadId) => targetSession.stepOver(threadId)
			);
			return jsonResult(result);
		} catch (error) {
			return jsonResult({ error: `Failed to step over: ${error}` });
		}
	}
}

class StepOutTool implements LanguageModelTool<DebugSessionIdInput> {
	constructor(private readonly _debugSessionService: DebugSessionService) { }

	async invoke(options: LanguageModelToolInvocationOptions<DebugSessionIdInput>, _token: CancellationToken): Promise<LanguageModelToolResult> {
		const { debugSessionId } = options.input;

		const sessions = this._debugSessionService.debugSessions.get();
		const targetSession = findSessionByFormattedId(sessions, debugSessionId);

		if (!targetSession) {
			return sessionNotFoundResult(this._debugSessionService, debugSessionId);
		}

		try {
			const result = await executeStepAndWaitForPause(
				targetSession,
				(threadId) => targetSession.stepOut(threadId)
			);
			return jsonResult(result);
		} catch (error) {
			return jsonResult({ error: `Failed to step out: ${error}` });
		}
	}
}

interface RunToLineInput {
	debugSessionId: string;
	filePath: string;
	line: number;
}

class RunToLineTool implements LanguageModelTool<RunToLineInput> {
	constructor(private readonly _debugSessionService: DebugSessionService) { }

	async invoke(options: LanguageModelToolInvocationOptions<RunToLineInput>, _token: CancellationToken): Promise<LanguageModelToolResult> {
		const { debugSessionId, filePath, line } = options.input;

		const sessions = this._debugSessionService.debugSessions.get();
		const targetSession = findSessionByFormattedId(sessions, debugSessionId);

		if (!targetSession) {
			return sessionNotFoundResult(this._debugSessionService, debugSessionId);
		}

		try {
			const threads = await targetSession.getThreads();
			if (threads.length === 0) {
				return jsonResult({ stopped: false, reason: 'No threads available' });
			}

			const threadId = threads[0].id;

			// Set a temporary breakpoint
			const bpResult = await targetSession.setBreakpoints({ path: filePath }, [{ line }]);
			if (bpResult.length === 0 || !bpResult[0].verified) {
				return jsonResult({ stopped: false, reason: `Could not set breakpoint at ${filePath}:${line}` });
			}

			const actualLine = bpResult[0].line;

			// Continue execution
			await targetSession.continue(threadId);

			// Wait for pause
			const newFrameId = await waitForCondition(
				() => {
					const frameId = targetSession.pausedStackFrameId.get();
					return frameId !== undefined ? frameId : undefined;
				},
				5000, // Longer timeout for runToLine
				50
			);

			if (newFrameId === undefined) {
				return jsonResult({ stopped: false, reason: 'Debugger did not hit the breakpoint within 5 seconds' });
			}

			const location = await getStopLocationWithContext(targetSession, threadId);
			if (!location) {
				return jsonResult({ stopped: false, reason: 'Could not determine stop location' });
			}

			return jsonResult({
				stopped: true,
				location,
				targetLine: line,
				actualBreakpointLine: actualLine,
			});
		} catch (error) {
			return jsonResult({ error: `Failed to run to line: ${error}` });
		}
	}
}

// ============================================================================
// Inspection Tools
// ============================================================================

interface GetStackTraceInput {
	debugSessionId: string;
	maxFrames?: number;
}

class GetStackTraceTool implements LanguageModelTool<GetStackTraceInput> {
	constructor(private readonly _debugSessionService: DebugSessionService) { }

	async invoke(options: LanguageModelToolInvocationOptions<GetStackTraceInput>, _token: CancellationToken): Promise<LanguageModelToolResult> {
		const { debugSessionId, maxFrames = 10 } = options.input;

		const sessions = this._debugSessionService.debugSessions.get();
		const targetSession = findSessionByFormattedId(sessions, debugSessionId);

		if (!targetSession) {
			return sessionNotFoundResult(this._debugSessionService, debugSessionId);
		}

		try {
			const threads = await targetSession.getThreads();
			if (threads.length === 0) {
				return jsonResult({ error: 'No threads available' });
			}

			const threadId = threads[0].id;

			// First get total count
			const fullTrace = await targetSession.getStackTrace({ threadId, levels: 100 });
			const totalFrames = fullTrace.totalFrames ?? fullTrace.stackFrames.length;
			const allFrames = fullTrace.stackFrames;

			// Build the response with smart truncation
			const result: {
				totalFrames: number;
				frames: (FormattedStackFrame | { skipped: number })[];
			} = {
				totalFrames,
				frames: [],
			};

			if (allFrames.length <= maxFrames) {
				// Show all frames
				for (let i = 0; i < allFrames.length; i++) {
					result.frames.push(await this._formatFrame(allFrames[i], i, i === 0));
				}
			} else {
				// Show top half, skip indicator, bottom half
				const topCount = Math.ceil(maxFrames / 2);
				const bottomCount = maxFrames - topCount;

				// Top frames (including detailed first frame)
				for (let i = 0; i < topCount; i++) {
					result.frames.push(await this._formatFrame(allFrames[i], i, i === 0));
				}

				// Skip indicator
				const skipped = allFrames.length - maxFrames;
				if (skipped > 0) {
					result.frames.push({ skipped });
				}

				// Bottom frames
				const bottomStart = allFrames.length - bottomCount;
				for (let i = bottomStart; i < allFrames.length; i++) {
					result.frames.push(await this._formatFrame(allFrames[i], i, false));
				}
			}

			return jsonResult(result);
		} catch (error) {
			return jsonResult({ error: `Failed to get stack trace: ${error}` });
		}
	}

	private async _formatFrame(frame: StackFrame, index: number, includeLineContext: boolean): Promise<FormattedStackFrame> {
		const result: FormattedStackFrame = {
			index,
			name: frame.name,
			file: frame.source?.path ?? '<unknown>',
			line: frame.line,
			column: frame.column,
		};

		if (includeLineContext && frame.source?.path) {
			const contextResult = await getLineContext(frame.source.path, frame.line);
			if (!('error' in contextResult)) {
				result.lineContext = contextResult.lineContext;
			}
		}

		return result;
	}
}

interface FormattedStackFrame {
	index: number;
	name: string;
	file: string;
	line: number;
	column: number;
	lineContext?: string;
}

interface GetLocalVariablesInput {
	debugSessionId: string;
	maxVariables?: number;
}

class GetLocalVariablesTool implements LanguageModelTool<GetLocalVariablesInput> {
	constructor(private readonly _debugSessionService: DebugSessionService) { }

	async invoke(options: LanguageModelToolInvocationOptions<GetLocalVariablesInput>, _token: CancellationToken): Promise<LanguageModelToolResult> {
		const { debugSessionId, maxVariables = 20 } = options.input;

		const sessions = this._debugSessionService.debugSessions.get();
		const targetSession = findSessionByFormattedId(sessions, debugSessionId);

		if (!targetSession) {
			return sessionNotFoundResult(this._debugSessionService, debugSessionId);
		}

		try {
			const frameId = targetSession.pausedStackFrameId.get();
			if (frameId === undefined) {
				return jsonResult({ error: 'Debug session is not paused. Cannot get local variables.' });
			}

			const scopes = await targetSession.getScopes(frameId);

			// Find the "Locals" scope (or first non-expensive scope)
			const localScope = scopes.find(s => s.name === 'Locals' || s.name === 'Local')
				?? scopes.find(s => !s.expensive);

			if (!localScope) {
				return jsonResult({ variables: [], message: 'No local scope found' });
			}

			const variables = await targetSession.getVariables(localScope.variablesReference, maxVariables);

			const formattedVariables = variables.map(v => ({
				name: v.name,
				value: this._truncateValue(v.value, 200),
				type: v.type,
			}));

			return jsonResult({
				scope: localScope.name,
				variables: formattedVariables,
				truncated: variables.length >= maxVariables,
			});
		} catch (error) {
			return jsonResult({ error: `Failed to get local variables: ${error}` });
		}
	}

	private _truncateValue(value: string, maxLength: number): string {
		if (value.length <= maxLength) {
			return value;
		}
		return value.slice(0, maxLength - 3) + '...';
	}
}

interface GetLineContextInput {
	filePath: string;
	line: number;
}

class GetLineContextTool implements LanguageModelTool<GetLineContextInput> {
	async invoke(options: LanguageModelToolInvocationOptions<GetLineContextInput>, _token: CancellationToken): Promise<LanguageModelToolResult> {
		const { filePath, line } = options.input;

		const result = await getLineContext(filePath, line);
		if ('error' in result) {
			return jsonResult({ error: result.error });
		}

		return jsonResult({
			file: filePath,
			line,
			lineContext: result.lineContext,
		});
	}
}

// ============================================================================
// Breakpoint Tools
// ============================================================================

interface SetBreakpointInput {
	debugSessionId: string;
	filePath: string;
	line: number;
}

class SetBreakpointTool implements LanguageModelTool<SetBreakpointInput> {
	constructor(private readonly _debugSessionService: DebugSessionService) { }

	async invoke(options: LanguageModelToolInvocationOptions<SetBreakpointInput>, _token: CancellationToken): Promise<LanguageModelToolResult> {
		const { debugSessionId, filePath, line } = options.input;

		const sessions = this._debugSessionService.debugSessions.get();
		const targetSession = findSessionByFormattedId(sessions, debugSessionId);

		if (!targetSession) {
			return sessionNotFoundResult(this._debugSessionService, debugSessionId);
		}

		try {
			const result = await targetSession.setBreakpoints({ path: filePath }, [{ line }]);

			if (result.length === 0) {
				return jsonResult({ success: false, error: 'No breakpoint was set' });
			}

			const bp = result[0];
			const actualLine = bp.line;

			// Get line context for the actual breakpoint line
			const contextResult = await getLineContext(filePath, actualLine);
			const lineContext = 'error' in contextResult ? undefined : contextResult.lineContext;

			return jsonResult({
				success: bp.verified,
				verified: bp.verified,
				requestedLine: line,
				actualLine,
				lineContext,
				message: bp.verified
					? `Breakpoint set at line ${actualLine}`
					: `Breakpoint at line ${actualLine} could not be verified (may be set when code is loaded)`,
			});
		} catch (error) {
			return jsonResult({ error: `Failed to set breakpoint: ${error}` });
		}
	}
}

// ============================================================================
// DOM Tools
// ============================================================================

interface CaptureDomNodeScreenshotInput {
	debugSessionId: string;
	expression: string;
}

class CaptureDomNodeScreenshotTool implements LanguageModelTool<CaptureDomNodeScreenshotInput> {
	constructor(
		private readonly _debugSessionService: DebugSessionService,
		private readonly _jsDebugSupport: JsDebugSupport,
	) { }

	async invoke(options: LanguageModelToolInvocationOptions<CaptureDomNodeScreenshotInput>, _token: CancellationToken): Promise<LanguageModelToolResult> {
		const { debugSessionId, expression } = options.input;

		const sessions = this._debugSessionService.debugSessions.get();
		const targetSession = findSessionByFormattedId(sessions, debugSessionId);

		if (!targetSession) {
			return sessionNotFoundResult(this._debugSessionService, debugSessionId);
		}

		const jsDebugSession = this._jsDebugSupport.getDebugSession(targetSession);
		if (!jsDebugSession) {
			return jsonResult({ error: 'This debug session does not support DOM screenshot capture (only browser/chrome debug sessions are supported)' });
		}

		try {
			const cdpClient = await jsDebugSession.getCdpClient();
			if (!cdpClient) {
				return jsonResult({ error: 'Could not connect to CDP. Make sure the debug session is a browser debug session.' });
			}

			// Evaluate the expression to get the DOM element and its bounding rect
			const evalResult = await cdpClient.request('Runtime.evaluate', {
				expression: `
					(() => {
						const element = ${expression};
						if (!element || !(element instanceof Element)) {
							return { error: 'Expression did not return a valid DOM element' };
						}
						const rect = element.getBoundingClientRect();
						return {
							x: rect.x,
							y: rect.y,
							width: rect.width,
							height: rect.height,
							tagName: element.tagName,
							id: element.id || undefined,
							className: element.className || undefined,
						};
					})()
				`,
				returnByValue: true,
			});

			if (evalResult.exceptionDetails) {
				return jsonResult({
					error: `Failed to evaluate expression: ${evalResult.exceptionDetails.text}`,
				});
			}

			const boundingInfo = evalResult.result.value as {
				error?: string;
				x: number;
				y: number;
				width: number;
				height: number;
				tagName: string;
				id?: string;
				className?: string;
			};

			if (boundingInfo.error) {
				return jsonResult({ error: boundingInfo.error });
			}

			if (boundingInfo.width === 0 || boundingInfo.height === 0) {
				return jsonResult({
					error: 'Element has zero width or height. It may be hidden or not rendered.',
					elementInfo: {
						tagName: boundingInfo.tagName,
						id: boundingInfo.id,
						className: boundingInfo.className,
					},
				});
			}

			// Capture screenshot with clip region
			const screenshotResult = await cdpClient.request('Page.captureScreenshot', {
				format: 'png',
				clip: {
					x: boundingInfo.x,
					y: boundingInfo.y,
					width: boundingInfo.width,
					height: boundingInfo.height,
					scale: 1,
				},
			});

			// Convert base64 to Uint8Array
			const base64Data = screenshotResult.data;
			const bytes = Buffer.from(base64Data, 'base64');

			return new LanguageModelToolResult([
				new LanguageModelTextPart(JSON.stringify({
					success: true,
					elementInfo: {
						tagName: boundingInfo.tagName,
						id: boundingInfo.id,
						className: boundingInfo.className,
						bounds: {
							x: boundingInfo.x,
							y: boundingInfo.y,
							width: boundingInfo.width,
							height: boundingInfo.height,
						},
					},
				}, null, 2)),
				LanguageModelDataPart.image(bytes, 'image/png'),
			]);
		} catch (error) {
			return jsonResult({ error: `Failed to capture screenshot: ${error}` });
		}
	}
}

// ============================================================================
// Script Exploration Tools
// ============================================================================

const MAX_OUTPUT_BYTES = 80 * 500; // ~40KB limit

interface ScriptInfo {
	scriptId: string;
	url: string;
	startLine: number;
	startColumn: number;
	endLine: number;
	endColumn: number;
	hash: string;
	isModule?: boolean;
	length?: number;
	sourceMapURL?: string;
}

interface GetLoadedScriptsInput {
	debugSessionId: string;
	searchPattern?: string;
	offset?: number;
	limit?: number;
}

class GetLoadedScriptsTool implements LanguageModelTool<GetLoadedScriptsInput> {
	constructor(
		private readonly _debugSessionService: DebugSessionService,
		private readonly _jsDebugSupport: JsDebugSupport,
	) { }

	async invoke(options: LanguageModelToolInvocationOptions<GetLoadedScriptsInput>, _token: CancellationToken): Promise<LanguageModelToolResult> {
		const { debugSessionId, searchPattern, offset = 0, limit = 50 } = options.input;

		const sessions = this._debugSessionService.debugSessions.get();
		const targetSession = findSessionByFormattedId(sessions, debugSessionId);

		if (!targetSession) {
			return sessionNotFoundResult(this._debugSessionService, debugSessionId);
		}

		const jsDebugSession = this._jsDebugSupport.getDebugSession(targetSession);
		if (!jsDebugSession) {
			return jsonResult({ error: 'This debug session does not support script exploration (only JS debug sessions are supported)' });
		}

		try {
			const cdpClient = await jsDebugSession.getCdpClient();
			if (!cdpClient) {
				return jsonResult({ error: 'Could not connect to CDP.' });
			}

			// Enable debugger to get scripts
			await cdpClient.request('Debugger.enable', {});

			// Get scripts from the debugger using js-debug's internal API
			const scriptsResult = await cdpClient.requestUntyped('JsDebug', 'scripts', {}) as {
				scripts: ScriptInfo[];
			} | undefined;

			let allScripts: ScriptInfo[] = scriptsResult?.scripts ?? [];

			// Apply search filter if provided
			let filteredScripts = allScripts;
			if (searchPattern) {
				try {
					const regex = new RegExp(searchPattern, 'i');
					filteredScripts = allScripts.filter(s => regex.test(s.url));
				} catch (e) {
					return jsonResult({ error: `Invalid search pattern: ${e}` });
				}
			}

			const totalCount = filteredScripts.length;

			// Apply pagination
			const paginatedScripts = filteredScripts.slice(offset, offset + limit);

			// Format output with truncation check
			const scriptList = paginatedScripts.map(s => ({
				scriptId: s.scriptId,
				url: s.url,
				lines: s.endLine - s.startLine + 1,
				isModule: s.isModule,
				hasSourceMap: !!s.sourceMapURL,
			}));

			let output = JSON.stringify({
				totalScripts: allScripts.length,
				filteredCount: totalCount,
				returnedCount: scriptList.length,
				offset,
				limit,
				hasMore: offset + limit < totalCount,
				scripts: scriptList,
			}, null, 2);

			// Truncate if too large
			if (output.length > MAX_OUTPUT_BYTES) {
				const truncatedScripts = scriptList.slice(0, Math.floor(scriptList.length * MAX_OUTPUT_BYTES / output.length));
				output = JSON.stringify({
					totalScripts: allScripts.length,
					filteredCount: totalCount,
					returnedCount: truncatedScripts.length,
					offset,
					limit,
					hasMore: true,
					truncated: true,
					truncatedFrom: scriptList.length,
					scripts: truncatedScripts,
				}, null, 2);
			}

			return new LanguageModelToolResult([new LanguageModelTextPart(output)]);
		} catch (error) {
			return jsonResult({ error: `Failed to get loaded scripts: ${error}` });
		}
	}
}

interface GetScriptSourceInput {
	debugSessionId: string;
	scriptId: string;
	searchPattern?: string;
	offset?: number;
	limit?: number;
	contextLines?: number;
}

class GetScriptSourceTool implements LanguageModelTool<GetScriptSourceInput> {
	constructor(
		private readonly _debugSessionService: DebugSessionService,
		private readonly _jsDebugSupport: JsDebugSupport,
	) { }

	async invoke(options: LanguageModelToolInvocationOptions<GetScriptSourceInput>, _token: CancellationToken): Promise<LanguageModelToolResult> {
		const { 
			debugSessionId, 
			scriptId, 
			searchPattern, 
			offset = 0, 
			limit = 100,
			contextLines = 5
		} = options.input;

		const sessions = this._debugSessionService.debugSessions.get();
		const targetSession = findSessionByFormattedId(sessions, debugSessionId);

		if (!targetSession) {
			return sessionNotFoundResult(this._debugSessionService, debugSessionId);
		}

		const jsDebugSession = this._jsDebugSupport.getDebugSession(targetSession);
		if (!jsDebugSession) {
			return jsonResult({ error: 'This debug session does not support script exploration (only JS debug sessions are supported)' });
		}

		try {
			const cdpClient = await jsDebugSession.getCdpClient();
			if (!cdpClient) {
				return jsonResult({ error: 'Could not connect to CDP.' });
			}

			// Get script source
			const sourceResult = await cdpClient.request('Debugger.getScriptSource', { scriptId });
			const source = sourceResult.scriptSource;
			const allLines = source.split('\n');
			const totalLines = allLines.length;

			// If search pattern is provided, find matching lines with context
			if (searchPattern) {
				let regex: RegExp;
				try {
					regex = new RegExp(searchPattern, 'gi');
				} catch (e) {
					return jsonResult({ error: `Invalid search pattern: ${e}` });
				}

				// Find all matching lines
				const matchingLineNumbers: number[] = [];
				for (let i = 0; i < allLines.length; i++) {
					if (regex.test(allLines[i])) {
						matchingLineNumbers.push(i + 1); // 1-indexed
					}
					regex.lastIndex = 0; // Reset regex state
				}

				const totalMatches = matchingLineNumbers.length;

				if (totalMatches === 0) {
					return jsonResult({
						scriptId,
						totalLines,
						searchPattern,
						totalMatches: 0,
						message: 'No matches found',
					});
				}

				// Apply pagination to matching lines
				const paginatedMatches = matchingLineNumbers.slice(offset, offset + limit);

				// Build context blocks for each match
				const matchBlocks: { matchLineNumber: number; contextStart: number; contextEnd: number; lines: string[] }[] = [];
				let currentOutputSize = 0;
				let truncatedAtMatch: number | undefined;

				for (const matchLine of paginatedMatches) {
					const contextStart = Math.max(1, matchLine - contextLines);
					const contextEnd = Math.min(totalLines, matchLine + contextLines);

					const blockLines: string[] = [];
					for (let lineNum = contextStart; lineNum <= contextEnd; lineNum++) {
						const prefix = lineNum === matchLine ? '>' : ' ';
						const lineContent = `${prefix}${String(lineNum).padStart(6)}: ${allLines[lineNum - 1]}`;
						blockLines.push(lineContent);
					}

					const blockSize = blockLines.join('\n').length + 50; // Extra for JSON structure
					if (currentOutputSize + blockSize > MAX_OUTPUT_BYTES) {
						truncatedAtMatch = matchBlocks.length;
						break;
					}

					matchBlocks.push({
						matchLineNumber: matchLine,
						contextStart,
						contextEnd,
						lines: blockLines,
					});
					currentOutputSize += blockSize;
				}

				const result: Record<string, unknown> = {
					scriptId,
					totalLines,
					searchPattern,
					totalMatches,
					returnedMatches: matchBlocks.length,
					offset,
					limit,
					hasMore: offset + limit < totalMatches,
					contextLines,
					matches: matchBlocks.map(b => ({
						matchLineNumber: b.matchLineNumber,
						context: b.lines.join('\n'),
					})),
				};

				if (truncatedAtMatch !== undefined) {
					result.truncated = true;
					result.truncatedAtMatch = truncatedAtMatch;
					result.message = `Output truncated at match ${truncatedAtMatch} of ${paginatedMatches.length} due to size limit`;
				}

				return new LanguageModelToolResult([new LanguageModelTextPart(JSON.stringify(result, null, 2))]);
			}

			// No search pattern - return lines with line numbers
			const startLine = offset + 1; // 1-indexed
			const endLine = Math.min(offset + limit, totalLines);

			const formattedLines: string[] = [];
			let currentOutputSize = 0;
			let truncatedAtLine: number | undefined;

			for (let lineNum = startLine; lineNum <= endLine; lineNum++) {
				const lineContent = `${String(lineNum).padStart(6)}: ${allLines[lineNum - 1]}`;

				if (currentOutputSize + lineContent.length + 1 > MAX_OUTPUT_BYTES - 500) { // Reserve space for metadata
					truncatedAtLine = lineNum;
					break;
				}

				formattedLines.push(lineContent);
				currentOutputSize += lineContent.length + 1;
			}

			const result: Record<string, unknown> = {
				scriptId,
				totalLines,
				returnedLines: formattedLines.length,
				startLine,
				endLine: startLine + formattedLines.length - 1,
				offset,
				limit,
				hasMore: endLine < totalLines,
				source: formattedLines.join('\n'),
			};

			if (truncatedAtLine !== undefined) {
				result.truncated = true;
				result.truncatedAtLine = truncatedAtLine;
				result.message = `Output truncated at line ${truncatedAtLine} due to size limit. Use offset/limit to paginate.`;
			}

			return new LanguageModelToolResult([new LanguageModelTextPart(JSON.stringify(result, null, 2))]);
		} catch (error) {
			return jsonResult({ error: `Failed to get script source: ${error}` });
		}
	}
}

// ============================================================================
// Low-level CDP Tool
// ============================================================================

interface CdpRequestInput {
	debugSessionId: string;
	method: string;
	params?: Record<string, unknown>;
}

class CdpRequestTool implements LanguageModelTool<CdpRequestInput> {
	constructor(
		private readonly _debugSessionService: DebugSessionService,
		private readonly _jsDebugSupport: JsDebugSupport,
	) { }

	async invoke(options: LanguageModelToolInvocationOptions<CdpRequestInput>, _token: CancellationToken): Promise<LanguageModelToolResult> {
		const { debugSessionId, method, params = {} } = options.input;

		const sessions = this._debugSessionService.debugSessions.get();
		const targetSession = findSessionByFormattedId(sessions, debugSessionId);

		if (!targetSession) {
			return sessionNotFoundResult(this._debugSessionService, debugSessionId);
		}

		const jsDebugSession = this._jsDebugSupport.getDebugSession(targetSession);
		if (!jsDebugSession) {
			return jsonResult({ error: 'This debug session does not support CDP requests (only JS debug sessions are supported)' });
		}

		try {
			const cdpClient = await jsDebugSession.getCdpClient();
			if (!cdpClient) {
				return jsonResult({ error: 'Could not connect to CDP.' });
			}

			// Parse method into domain and method name
			const dotIndex = method.indexOf('.');
			if (dotIndex === -1) {
				return jsonResult({ error: 'Invalid CDP method format. Expected "Domain.method" (e.g., "Runtime.evaluate", "DOM.getDocument")' });
			}

			const domain = method.substring(0, dotIndex);
			const methodName = method.substring(dotIndex + 1);

			// Execute the CDP request
			const result = await cdpClient.requestUntyped(domain, methodName, params);

			// Truncate output if too large
			let output = JSON.stringify({ success: true, result }, null, 2);
			if (output.length > MAX_OUTPUT_BYTES) {
				const truncatedResult = JSON.stringify(result);
				const allowedLength = MAX_OUTPUT_BYTES - 200; // Reserve space for wrapper JSON
				output = JSON.stringify({
					success: true,
					result: truncatedResult.substring(0, allowedLength),
					truncated: true,
					originalLength: truncatedResult.length,
					message: `Result truncated from ${truncatedResult.length} to ${allowedLength} characters`,
				}, null, 2);
			}

			return new LanguageModelToolResult([new LanguageModelTextPart(output)]);
		} catch (error) {
			return jsonResult({ error: `CDP request failed: ${error}` });
		}
	}
}
