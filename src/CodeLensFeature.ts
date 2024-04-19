import { CodeLens, Position, Range, languages } from "vscode";
import { Disposable } from "./utils/disposables";
import { editPropertyCommandId } from "./extension";

export class OpenPropertyCodeLensFeature extends Disposable {
    constructor() {
        super();

        this._register(
            languages.registerCodeLensProvider([{ language: "javascript" }, { language: "typescript" }], {
                provideCodeLenses(document, token) {
                    const lineRegexp = /(?<=($|\n)[ \t]*)([a-zA-Z_0-9\.$(), ]+);[ \t]*\/\/[ \t]*editable/g;

                    const text = document.getText();

                    const result: { lineNumber: number; expressions: string[]; column: number; }[] = [];
                    for (const match of text.matchAll(lineRegexp)) {
                        const line = document.positionAt(match.index).line;
                        result.push({
                            lineNumber: line,
                            column: match.index - document.offsetAt(new Position(line, 0)),
                            expressions: match[2].split(','),
                        });
                    }

                    return result.map<CodeLens>(({ lineNumber, column, expressions }) => {
                        return {
                            range: new Range(lineNumber, column, lineNumber, column),
                            command: {
                                title: '$(edit) Open Property In Editor',
                                command: editPropertyCommandId,
                                arguments: [{ expressions }],
                            },
                            isResolved: true,
                        };
                    });
                },
            })
        );
    }
}
