import { ChannelFactory, IChannelHandler, API, SimpleTypedRpcConnection, MakeSideAsync } from "./rpc";

function createChannelFactoryFromDebugChannel(host: IHost): { factory: ChannelFactory, handler: { handleRequest: (data: unknown) => unknown } } {
    let h: IChannelHandler | undefined;
    const factory: ChannelFactory = (handler) => {
        h = handler;
        return {
            sendNotification: data => {
                host.sendNotification(data);
            },
            sendRequest: data => {
                throw new Error('not supported');
            },
        };
    };
    return {
        factory,
        handler: {
            handleRequest: (data: any) => {
                if (data.type === 'notification') {
                    return h?.handleNotification(data.data);
                } else {
                    return h?.handleRequest(data.data);
                }
            },
        },
    }
}

interface IHost {
    sendNotification: (data: unknown) => void;
}

interface GlobalObj {
    $$debugValueEditor_debugChannels: Record<string, (host: IHost) => { handleRequest: (data: unknown) => unknown }>;
}

export function registerDebugChannel<T extends { channelId: string } & API>(
    channelId: T['channelId'],
    createClient: () => T['client'],
): SimpleTypedRpcConnection<MakeSideAsync<T['host']>> {
    const g = globalThis as any as GlobalObj;

    let queuedNotifications: unknown[] = [];
    let curHost: IHost | undefined = undefined;

    const { factory, handler } = createChannelFactoryFromDebugChannel({
        sendNotification: (data) => {
            if (curHost) {
                curHost.sendNotification(data);
            } else {
                queuedNotifications.push(data);
            }
        },
    });

    let curClient: T['client'] | undefined = undefined;

    (g.$$debugValueEditor_debugChannels ?? (g.$$debugValueEditor_debugChannels = {}))[channelId] = (host) => {
        curClient = createClient();
        curHost = host;
        for (const n of queuedNotifications) {
            host.sendNotification(n);
        }
        queuedNotifications = [];
        return handler;
    };

    return SimpleTypedRpcConnection.createClient<T>(factory, () => {
        if (!curClient) { throw new Error('Not supported'); }
        return curClient;
    });
}
