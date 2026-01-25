import { TextDocumentShowOptions, Uri, ViewColumn, commands, window, workspace } from "vscode";

export class ErrorMessage {
    static showIfError(value: unknown): value is ErrorMessage {
        const isError = value instanceof ErrorMessage;
        if (isError) {
            window.showErrorMessage(value.message);
        }
        return isError;
    }

    static throwIfError<T>(value: T | ErrorMessage): asserts value is T {
        if (value instanceof ErrorMessage) {
            throw new Error(value.message);
        }
    }

    static isErr(value: unknown): value is ErrorMessage {
        return value instanceof ErrorMessage;
    }

    constructor(public readonly message: string) {
    }
}

export async function showDocument(uri: Uri, viewColumn = ViewColumn.Beside) {
    const options: TextDocumentShowOptions = { viewColumn, preserveFocus: true };
    await commands.executeCommand('vscode.open', uri, options);
}

export async function setContextKey(key: string, value: unknown) {
    await commands.executeCommand('setContext', key, value);
}

export function isDefined<T>(value: T | undefined): value is T {
    return value !== undefined;
}

export function wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForCondition<T>(
    condition: () => T | undefined,
    timeoutMs: number,
    pollIntervalMs = 100
): Promise<T | undefined> {
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
        const result = condition();
        if (result !== undefined) {
            return result;
        }
        await wait(pollIntervalMs);
    }
    return undefined;
}

export interface LineContextResult {
    lineContext: string;
    targetLine: number;
    actualLines: { lineNumber: number; content: string; isTarget: boolean }[];
}

/**
 * Reads source code context around a specific line.
 * Returns 3 lines above, the target line (marked with >), and 3 lines below.
 * Line numbers are 1-indexed.
 */
export async function getLineContext(
    filePath: string,
    targetLine: number,
    contextLines = 3
): Promise<LineContextResult | { error: string }> {
    try {
        const uri = Uri.file(filePath);
        const document = await workspace.openTextDocument(uri);
        const totalLines = document.lineCount;

        if (targetLine < 1 || targetLine > totalLines) {
            return { error: `Line ${targetLine} is out of range (file has ${totalLines} lines)` };
        }

        const startLine = Math.max(1, targetLine - contextLines);
        const endLine = Math.min(totalLines, targetLine + contextLines);

        const maxLineNumWidth = endLine.toString().length;
        const lines: { lineNumber: number; content: string; isTarget: boolean }[] = [];
        const formattedLines: string[] = [];

        for (let i = startLine; i <= endLine; i++) {
            const lineContent = document.lineAt(i - 1).text;
            const isTarget = i === targetLine;
            const marker = isTarget ? '>' : ' ';
            const lineNumStr = i.toString().padStart(maxLineNumWidth, ' ');
            formattedLines.push(`${marker} ${lineNumStr} | ${lineContent}`);
            lines.push({ lineNumber: i, content: lineContent, isTarget });
        }

        return {
            lineContext: formattedLines.join('\n'),
            targetLine,
            actualLines: lines,
        };
    } catch (e) {
        return { error: `Failed to read file "${filePath}": ${e}` };
    }
}
