/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IDisposable } from '../../disposables';
export { DisposableStore, IDisposable } from '../../disposables';

export function markAsDisposed(obj: any): void {
}

export function trackDisposable(obj: any): void {
}

export function assertFn(condition: () => boolean): void {
}

export class BugIndicatingError extends Error {
	constructor(message?: string) {
		super(message || 'An unexpected bug occurred.');
		Object.setPrototypeOf(this, BugIndicatingError.prototype);

		// Because we know for sure only buggy code throws this,
		// we definitely want to break here and fix the bug.
		// eslint-disable-next-line no-debugger
		// debugger;
	}
}

export function onBugIndicatingError(error: any): void {
}

export type EqualityComparer<T> = (a: T, b: T) => boolean;

/**
 * Compares two items for equality using strict equality.
*/
export const strictEquals: EqualityComparer<any> = (a, b) => a === b;

export interface IValueWithChangeEvent<T> {
	readonly onDidChange: Event<void>;
	get value(): T;
}

export interface Event<T> {
	(listener: (e: T) => any, thisArgs?: any): IDisposable;
}
