import { DebugSession, EventEmitter, debug } from "vscode";
import { IObservable, autorun, derived, observableFromEvent, observableSignal, observableValue } from "../utils/observables/observable";
import { Disposable } from "../utils/disposables";

export class DebugSessionService extends Disposable {
    private readonly _activeSession = observableFromEvent<DebugSession | undefined>(debug.onDidChangeActiveDebugSession, () => debug.activeDebugSession);
    private readonly _activeSessionProxy = derived(this, reader => {
        const s = this._activeSession.read(reader);
        if (!s) {
            return undefined;
        }
        this._debugSessionsChangedSignal.read(reader);
        const proxy = this._debugSessions.get(s);
        return proxy;
    })
    public readonly activeSession: IObservable<DebugSessionProxy | undefined> = this._activeSessionProxy;

    private readonly _debugSessionsChangedSignal = observableSignal(this);
    private readonly _debugSessions = new Map<DebugSession, DebugSessionProxy>();

    public readonly debugSessions = derived(this, reader => {
        this._debugSessionsChangedSignal.read(reader);
        return [...this._debugSessions.values()];
    });

    constructor() {
        super();

        const log = false;

        const initializeDebugSession = (debugSession: DebugSession) => {
            if (this._debugSessions.has(debugSession)) {
                return;
            }
            const debugSessionProxy = new DebugSessionProxy(debugSession);

            if (log) {
                console.log(`DebugSessionService.create: ${debugSessionProxy}`);
            }

            this._debugSessions.set(debugSession, debugSessionProxy);
            debugSessionProxy.onDidTerminate(() => {
                if (log) {
                    console.log(`DebugSessionService.onDidTerminate: ${debugSessionProxy}`);
                }

                this._debugSessions.delete(debugSession);
                this._debugSessionsChangedSignal.trigger(undefined);
            });

            this._debugSessionsChangedSignal.trigger(undefined);
        };

        this._register(autorun(reader => {
            const activeSession = this._activeSession.read(reader);
            if (activeSession) {
                initializeDebugSession(activeSession);
            }
        }));

        this._register(debug.onDidStartDebugSession(initializeDebugSession));

        this._register(debug.onDidTerminateDebugSession(debugSession => {
            const session = this._debugSessions.get(debugSession);
            if (session) {
                session['_onDidTerminateEmitter'].fire();
            }
        }));

        this._register(debug.registerDebugAdapterTrackerFactory("*", {
            createDebugAdapterTracker: (session) => {
                const curThreadId = observableValue<number | undefined>('threadId', undefined);

                const sessionProxy = derived(reader => {
                    /** @description sessionProxy */
                    this._debugSessionsChangedSignal.read(reader);
                    return this._debugSessions.get(session);
                });

                const a = autorun(async reader => {
                    const s = sessionProxy.read(reader);
                    if (!s) { return; }

                    const threadId = curThreadId.read(reader);

                    if (threadId !== undefined) {
                        const r = await s.getStackTrace({
                            threadId,
                            startFrame: 0,
                            levels: 1,
                        });
                        s["_pausedStackFrameId"].set(
                            r.stackFrames.length > 0
                                ? r.stackFrames[0].id
                                : undefined,
                            undefined);
                    } else {
                        s["_pausedStackFrameId"].set(undefined, undefined);
                    }
                });

                return {
                    onExit: () => {
                        a.dispose();
                    },
                    onDidSendMessage: async (msg) => {
                        const m = msg as DapMessage;

                        if (m.type === "event") {
                            if (m.event === "stopped") {
                                const threadId = m.body.threadId;
                                curThreadId.set(threadId, undefined);
                            }
                        } else if (m.type === "response") {
                            if (m.command === "continue" ||
                                m.command === "next" ||
                                m.command === "stepIn" ||
                                m.command === "stepOut") {
                                curThreadId.set(undefined, undefined);
                            }
                        }
                    },
                };
            },
        }));
    }
}

export class DebugSessionProxy {
    private readonly _pausedStackFrameId = observableValue<number | undefined>(this, undefined);
    public readonly pausedStackFrameId: IObservable<number | undefined> = this._pausedStackFrameId;

    private readonly _onDidTerminateEmitter = new EventEmitter<void>();

    constructor(public readonly session: DebugSession) {
    }

    public toString(): string {
        return `DebugSessionProxy ${this.session.name}`;
    }

    public findSelfOrParent(predicate: (session: DebugSession) => boolean): DebugSession | undefined {
        let s: DebugSession | undefined = this.session;
        while (s) {
            if (predicate(s)) {
                return s;
            }
            s = s.parentSession;
        }
        return undefined;
    }

    public readonly onDidTerminate = this._onDidTerminateEmitter.event;

    /**
     * Evaluates the given expression.
     * If context is "watch", long results are usually shortened.
     */
    public async evaluate(args: {
        expression: string;
        frameId: number | undefined;
        context: "watch" | "repl" | "copy";
    }): Promise<{ result: string; variablesReference: number }> {
        const reply = await this.session.customRequest("evaluate", {
            expression: args.expression,
            frameId: args.frameId,
            context: args.context,
        });
        return {
            result: reply.result,
            variablesReference: reply.variablesReference,
        };
    }

    public async getStackTrace(args: {
        threadId: number;
        startFrame?: number;
        levels?: number;
    }): Promise<StackTraceInfo> {
        try {
            const reply = (await this.session.customRequest("stackTrace", {
                threadId: args.threadId,
                levels: args.levels,
                startFrame: args.startFrame || 0,
            })) as { totalFrames?: number; stackFrames: StackFrame[] };
            return reply;
        } catch (e) {
            console.error(e);
            throw e;
        }
    }

    public async getPreferredUILocation(args: { url?: string, source?: { path: string }, line: number, column: number }): Promise<PreferredUILocation> {
        try {
            const reply = (await this.session.customRequest("getPreferredUILocation", {
                originalUrl: args.url,
                source: args.source,
                line: args.line,
                column: args.column,
            })) as PreferredUILocation;
            return reply;
        } catch (e) {
            if (args.url) {
                return {
                    source: { name: args.url, path: args.url },
                    line: args.line,
                    column: args.column,
                };
            }

            console.error(e);
            throw e;
        }
    }
}

export interface PreferredUILocation {
    source: { name: string; path: string };
    line: number;
    column: number;
}

export interface StackTraceInfo {
    totalFrames?: number;
    stackFrames: StackFrame[];
}

export interface StackFrame {
    id: number;
    name: string;
    source: { name: string; path: string };
}

type DapMessage =
    | StoppedEventDapMessage
    | ThreadsResponseDapMessage
    | ContinueLikeResponseDapMessage;

interface ContinueLikeResponseDapMessage {
    type: "response";
    command:
    | "continue"
    | "stepIn"
    | "stepOut"
    | "next";
}

interface StoppedEventDapMessage {
    type: "event";
    event: "stopped";
    body: {
        threadId: number;
    };
}

interface ThreadsResponseDapMessage {
    type: "response";
    command: "threads";
    success: boolean;
    body: {
        threads: ThreadInfo[];
    };
}

interface ThreadInfo {
    id: number;
    name: string;
}
