
export type Validator<T> = (value: unknown) => value is T;

export function assumeType<T>(): Validator<T> {
    return (value): value is T => true;
}
