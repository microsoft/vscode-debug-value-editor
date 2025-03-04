/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IDisposable } from "../../commonFacade/deps";

export function getFirstStackFrameOutsideOf(stack: string, pattern: RegExp): ILocation {
	const lines = stack.split('\n');
	for (const line of lines.slice(1)) {
		if (pattern.test(line)) {
			continue;
		}
		const result = parseLine(line);
		if (result) {
			return result;
		}
	}
	throw new Error('Could not find relevant stack frame');
}

export interface ILocation {
	fileName: string;
	line: number;
	column: number;
	id: string;
}

function parseLine(stackLine: string): ILocation | undefined {
	const match = stackLine.match(/\((.*):(\d+):(\d+)\)/);
	if (!match) {
		return undefined;
		// throw new Error('Could not parse stack');
	}
	return {
		fileName: match[1],
		line: parseInt(match[2]),
		column: parseInt(match[3]),
		id: stackLine,
	};
}

export class Debouncer implements IDisposable {
	private _timeout: any | undefined = undefined;

	public debounce(fn: () => void, timeoutMs: number): void {
		if (this._timeout !== undefined) {
			clearTimeout(this._timeout);
		}
		this._timeout = setTimeout(() => {
			this._timeout = undefined;
			fn();
		}, timeoutMs);
	}

	dispose(): void {
		if (this._timeout !== undefined) {
			clearTimeout(this._timeout);
		}
	}
}

export class Throttler implements IDisposable {
	private _timeout: any | undefined = undefined;

	public throttle(fn: () => void, timeoutMs: number): void {
		if (this._timeout === undefined) {
			this._timeout = setTimeout(() => {
				this._timeout = undefined;
				fn();
			}, timeoutMs);
		}
	}

	dispose(): void {
		if (this._timeout !== undefined) {
			clearTimeout(this._timeout);
		}
	}
}

export function deepAssign<T>(target: T, source: T): void {
	for (const key in source) {
		if (!!target[key] && typeof target[key] === 'object' && !!source[key] && typeof source[key] === 'object') {
			deepAssign(target[key], source[key]);
		} else {
			target[key] = source[key];
		}
	}
}

export function deepAssignDeleteNulls<T>(target: T, source: T): void {
	for (const key in source) {
		if (source[key] === null) {
			delete target[key];
		} else if (!!target[key] && typeof target[key] === 'object' && !!source[key] && typeof source[key] === 'object') {
			deepAssignDeleteNulls(target[key], source[key]);
		} else {
			target[key] = source[key];
		}
	}
}
