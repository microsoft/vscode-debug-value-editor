/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export type DeclarationId = number;

export type ObjectId = number;

export type DeclarationType = 'observable/value' | 'observable/derived' | 'autorun';

export type DebuggerApi = {
    channelId: 'observableDevTools',
    host: {
        notifications: {
            // Scales with the length of the source code. Called less than 10k per debug session (probably around 1-2k).
            onDeclarationDiscovered(declarationId: DeclarationId, type: DeclarationType, url: string, line: number, column: number): void;

            onObservableListenerCountChanged(declarationId: DeclarationId, observableId: ObjectId, newListenerCount: number): void;
            onObservableChanged(observableId: ObjectId, newFormattedValue: string): void;
        }
        requests: {},
    };
    client: {
        notifications: {
            setFilter(idsToListenFor: DeclarationId[]): void;

            logObservableValue(observableId: ObjectId): void;
        },
        requests: {
            //getActiveObservableIds: (declarationId: DeclarationId) => number;
            getObservableValueFormattedValue(observableId: ObjectId): string;
        }
    };
};
