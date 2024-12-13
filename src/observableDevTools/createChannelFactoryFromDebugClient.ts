import { IDebugChannel } from "../debugService/IDebugSupport";
import { ChannelFactory, IChannelHandler, IChannel } from "./rpc";


export function createChannelFactoryFromDebugChannel(client: IDebugChannel): ChannelFactory {
    return (handler: IChannelHandler): IChannel => {
        client.onNotification(e => {
            handler.handleNotification(e.notificationData);
        });
        client.connect();

        return {
            sendNotification: (data) => {
                client.sendRequest({ type: 'notification', data });
            },
            sendRequest: async (data) => {
                const result = await client.sendRequest({ type: 'request', data });
                return result.type === 'error'
                    ? { type: 'error', value: result.value }
                    : { type: 'result', value: result.value };
            },
        };
    };
}
