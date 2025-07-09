import { Command, commands } from "vscode";
import { Validator } from "./utils/Validator";
import { IDisposable } from "./utils/disposables";

export class CommandDef<T> {
    constructor(
        public readonly id: string,
        public readonly validator: Validator<T>
    ) { }

    toCommand(details: { title: string, tooltip?: string }, arg: T): Command {
        return {
            command: this.id,
            title: details.title,
            tooltip: details.tooltip,
            arguments: [arg],
        };
    }

    register(run: (args: T) => Promise<unknown> | unknown): IDisposable {
        return commands.registerCommand(this.id, run);
    }

    toMarkdownCommand(title: string, args: T): string {
        return `[${title}](command:${this.id}?${encodeURIComponent(JSON.stringify(args))})`;
    }
}
