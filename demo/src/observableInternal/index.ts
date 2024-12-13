/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// This is a facade for the observable implementation. Only import from here!

import { observableValueOpts } from './api.js';
import { autorun, autorunDelta, autorunHandleChanges, autorunOpts, autorunWithStore, autorunWithStoreHandleChanges } from './autorun.js';
import { asyncTransaction, disposableObservableValue, globalTransaction, observableValue, subtransaction, transaction, TransactionImpl, type IChangeContext, type IChangeTracker, type IObservable, type IObserver, type IReader, type ISettable, type ISettableObservable, type ITransaction, } from './base.js';
import { derived, derivedDisposable, derivedHandleChanges, derivedOpts, derivedWithSetter, derivedWithStore } from './derived.js';
import { ObservableLazy, ObservableLazyPromise, ObservablePromise, PromiseResult, } from './promise.js';
import { constObservable, debouncedObservable, derivedConstOnceDefined, derivedObservableWithCache, derivedObservableWithWritableCache, keepObserved, latestChangedValue, mapObservableArrayCached, observableFromEvent, observableFromEventOpts, observableFromPromise, observableFromValueWithChangeEvent, observableSignal, observableSignalFromEvent, recomputeInitiallyAndOnChange, runOnChange, runOnChangeWithStore, ValueWithChangeEventFromObservable, wasEventTriggeredRecently, type IObservableSignal, } from './utils.js';

export type {
	DebugOwner, IChangeContext,
	IChangeTracker,
	IObservable,
	IObservableSignal,
	IObserver,
	IReader,
	ISettable,
	ISettableObservable,
	ITransaction
};

export {
	asyncTransaction,
	autorun,
	autorunDelta,
	autorunHandleChanges,
	autorunOpts,
	autorunWithStore,
	autorunWithStoreHandleChanges,
	constObservable,
	debouncedObservable,
	derived,
	derivedConstOnceDefined,
	derivedDisposable,
	derivedHandleChanges,
	derivedObservableWithCache,
	derivedObservableWithWritableCache,
	derivedOpts,
	derivedWithSetter,
	derivedWithStore,
	disposableObservableValue,
	globalTransaction,
	keepObserved,
	latestChangedValue,
	mapObservableArrayCached,
	observableFromEvent,
	observableFromEventOpts,
	observableFromPromise,
	observableFromValueWithChangeEvent,
	ObservableLazy,
	ObservableLazyPromise,
	ObservablePromise,
	observableSignal,
	observableSignalFromEvent,
	observableValue,
	observableValueOpts,
	PromiseResult,
	recomputeInitiallyAndOnChange,
	runOnChange,
	runOnChangeWithStore,
	subtransaction,
	transaction,
	TransactionImpl,
	ValueWithChangeEventFromObservable,
	wasEventTriggeredRecently,
};

import {
	ConsoleObservableLogger,
	setLogger
} from './logging.js';

import { DebugOwner } from './debugName.js';
import { DevToolsLogger } from './debugger/impl.js';

setLogger(new DevToolsLogger());