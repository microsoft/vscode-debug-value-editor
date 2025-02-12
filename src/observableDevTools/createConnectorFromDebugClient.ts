import { IDebugChannel } from "../debugService/IDebugSupport";
import { IChannel, IMessageListener, IMessageSender, RpcRequestResult } from "./rpc";

const enableLogging = true;

export function createRpcChannelFromDebugChannel(client: IDebugChannel): IChannel {
    return {
        connect: (listener: IMessageListener): IMessageSender => {
            client.onNotification(e => {
                if (enableLogging) {
                    console.log(`<< ${JSON.stringify(e.notificationData)}`);//
                }
                listener.handleNotification(e.notificationData);
            });
            client.listenForNotifications();

            return {
                sendNotification: (data) => {
                    if (enableLogging) {
                        console.log(`>> ${JSON.stringify(data)}`);
                    }
                    client.sendRequest({ type: 'notification', data });
                },
                sendRequest: async (data) => {
                    const result = (await client.sendRequest({ type: 'request', data })) as RpcRequestResult;
                    return result;
                },
            };
        }
    };
}
