
export interface IChannel {
    connect(listener: IMessageListener): IMessageSender;
}

export interface IMessageSender {
    sendNotification(data: unknown): void;
    sendRequest(data: unknown): Promise<RpcRequestResult>;
}

export interface IMessageListener {
    handleNotification(notificationData: unknown): void;
    handleRequest(requestData: unknown): Promise<RpcRequestResult> | RpcRequestResult;
}

export type RpcRequestResult = { type: 'result', value: unknown } | { type: 'error', value: unknown };

export type API = {
    host: Side;
    client: Side;
}

export type Side = {
    notifications: Record<string, (...args: any[]) => void>;
    requests: Record<string, (...args: any[]) => Promise<unknown> | unknown>;
}

type MakeAsyncIfNot<TFn> = TFn extends (...args: infer TArgs) => infer TResult ? TResult extends Promise<unknown> ? TFn : (...args: TArgs) => Promise<TResult> : never

export type MakeSideAsync<T extends Side> = {
    notifications: T['notifications'];
    requests: { [K in keyof T['requests']]: MakeAsyncIfNot<T['requests'][K]> }
};

export class SimpleTypedRpcConnection<T extends Side> {
    public static createHost<T extends API>(channel: IChannel, handler: T['host']): SimpleTypedRpcConnection<MakeSideAsync<T['client']>> {
        return new SimpleTypedRpcConnection(channel, handler);
    }

    public static createClient<T extends API>(channel: IChannel, handler: T['client']): SimpleTypedRpcConnection<MakeSideAsync<T['host']>> {
        return new SimpleTypedRpcConnection(channel, handler);
    }

    public readonly api: T;
    private readonly _sender: IMessageSender;

    private constructor(
        private readonly _channel: IChannel,
        private readonly _handler: Side,
    ) {
        this._sender = this._channel.connect({
            handleNotification: (notificationData) => {
                const m = notificationData as OutgoingMessage;
                this._handler.notifications[m[0]](...m[1]);
            },
            handleRequest: (requestData) => {
                const m = requestData as OutgoingMessage;
                try {
                    const result = this._handler.requests[m[0]](...m[1]);
                    return { type: 'result', value: result };
                } catch (e) {
                    return { type: 'error', value: e };
                }
            },
        });

        const requests = new Proxy({}, {
            get: (target, key: string) => {
                return async (...args: any[]) => {
                    const result = await this._sender.sendRequest([key, args] satisfies OutgoingMessage);
                    if (result.type === 'error') {
                        throw result.value;
                    } else {
                        return result.value;
                    }
                }
            }
        });

        const notifications = new Proxy({}, {
            get: (target, key: string) => {
                return (...args: any[]) => {
                    this._sender.sendNotification([key, args] satisfies OutgoingMessage);
                }
            }
        });

        this.api = { notifications: notifications, requests: requests } as any;
    }
}

type OutgoingMessage = [
    method: string,
    args: unknown[],
];

export function createLoggingConnectionLink(baseChannel: IChannel): IChannel {
    return {
        connect: (listener: IMessageListener): IMessageSender => {
            const base = baseChannel.connect({
                handleNotification: (notificationData) => {
                    console.log('<< NFN: ', JSON.stringify(notificationData));
                    listener.handleNotification(notificationData);
                },
                handleRequest: (requestData) => {
                    console.log('<< REQ: ', JSON.stringify(requestData));
                    return listener.handleRequest(requestData);
                },
            });

            return {
                sendNotification: (data) => {
                    console.log('>> NFN: ', JSON.stringify(data));
                    base.sendNotification(data);
                },
                sendRequest: async (data) => {
                    console.log('>> REQ: ', JSON.stringify(data));
                    const result = await base.sendRequest(data);
                    console.log('<< RES: ', JSON.stringify(result));
                    return result;
                },
            };
        }
    };
}
