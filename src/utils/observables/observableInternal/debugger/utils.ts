export function getFirstStackFrameOutsideOf(stack: string, folderName: string): ILocation {
    const lines = stack.split('\n');
    for (const line of lines.slice(1)) {
        if (line.includes(folderName)) {
            continue;
        }
        return parseLine(line);
    }
    throw new Error('Could not find stack outside of ' + folderName);
}

export interface ILocation {
    fileName: string;
    line: number;
    column: number;
    id: string;
}

function parseLine(stackLine: string): ILocation {
    const match = stackLine.match(/\((.*):(\d+):(\d+)\)/);
    if (!match) {
        throw new Error('Could not parse stack');
    }
    return {
        fileName: match[1],
        line: parseInt(match[2]),
        column: parseInt(match[3]),
        id: stackLine,
    };
}
