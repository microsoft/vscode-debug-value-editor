import { CodeLens, Position, Range, languages } from "vscode";
import { Disposable } from "./utils/disposables";

export class OpenPropertyCodeLensFeature extends Disposable {
    constructor() {
        super();

        this._register(
            languages.registerCodeLensProvider([{ language: "javascript" }, { language: "typescript" }], {
                provideCodeLenses(document, token) {
                    const lineRegexp = /(?<=($|\n)[ \t]*)([a-zA-Z_0-9\.$]+);[ \t]*\/\/[ \t]*editable/g;

                    const text = document.getText();

                    const result: { lineNumber: number; expression: string; column: number; }[] = [];
                    for (const match of text.matchAll(lineRegexp)) {
                        const line = document.positionAt(match.index).line;
                        result.push({
                            lineNumber: line,
                            column: match.index - document.offsetAt(new Position(line, 0)),
                            expression: match[2],
                        });
                    }

                    return result.map<CodeLens>(({ lineNumber, column, expression }) => {
                        return {
                            range: new Range(lineNumber, column, lineNumber, column),
                            command: {
                                title: '$(edit) Open Property In Editor',
                                command: 'debug-value-editor.edit-property',
                                arguments: [{ expression: expression }],
                            },
                            isResolved: true,
                        };
                    });
                },
            })
        );
    }
}
