/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export type DeclarationId = number;

export type EntityId = number;

export type DeclarationType = 'observable/value' | 'observable/derived' | 'autorun' | 'transaction';

export interface IDeclarations {
    decls: Record<DeclarationId, IDeclaration | null>;
}

export interface ISummarizedEntities {
    declStates: Record<DeclarationId, IDeclarationSummary | null>;
    entities: Record<EntityId, Entity | null>;
}

export type Entity = IObservableValue | IDerivedObservable | IAutorun;

export type StateUpdate = Partial<IDeclarations> & DeepPartial<ISummarizedEntities>;
type DeepPartial<T> = { [TKey in keyof T]?: DeepPartial<T[TKey]> };

/** Immutable */
export interface IDeclaration {
    id: DeclarationId;
    type: DeclarationType;

    url: string;
    line: number;
    column: number;
}

export interface IDeclarationSummary {
    activeInstances: number;
    recentEntities: EntityId[]; // Limited to 3 last owners
}

export interface IEntity {
    entityId: EntityId;
    declarationId: DeclarationId | undefined;
    ownerId: OwnerId | undefined;
    name: string;
}

export interface IObserver extends IEntity {
    updateCount: number;
}

export interface IObservable extends IEntity {
    formattedValue: string | undefined;
}

export interface IObservableValue extends IObservable {
    type: 'observable/value';
}

export interface IDerivedObservable extends IObservable, IObserver {
    type: 'observable/derived';
    state: 'noValue' | 'dependenciesMightHaveChanged' | 'stale' | 'upToDate';
}

export interface IAutorun extends IObserver {
    type: 'autorun';
    state: 'dependenciesMightHaveChanged' | 'stale' | 'upToDate';
    runCount: number;
}

export type OwnerId = number;

export type DebuggerApi = {
    channelId: 'observableDevTools',
    host: {
        notifications: {
            handleChange(update: StateUpdate): void;
        }
        requests: {},
    };
    client: {
        notifications: {
            setDeclarationIdFilter(declarationIds: DeclarationId[]): void;
            logObservableValue(observableId: EntityId): void;
        },
        requests: {
            getDeclarations(): IDeclarations;
            getSummarizedEntities(): ISummarizedEntities;
        }
    };
};
