import {
  credentials,
  ClientReadableStream,
  makeClientConstructor,
} from "@grpc/grpc-js";
import * as MurmurService from "../lib/MurmurRPC_grpc_pb";
import { Server, TextMessage, Channel } from "../lib/MurmurRPC_pb";
import {
  Bridge,
  RoomBridgeStore,
  MatrixRoom,
  WeakEvent,
} from "matrix-appservice-bridge";
import { MurmurConfig, JoinPartType } from "./types";
import { MatrixClient } from "matrix-js-sdk";

export default class Murmur {
  private addr: string;
  private server: Server | undefined;
  private matrixClient: MatrixClient | undefined;
  client: MurmurService.V1Client | undefined;

  constructor(addr: string) {
    this.addr = addr;
    return;
  }

  // Init connection
  connectClient(): void {
    const MurmurClient = makeClientConstructor(
      // @ts-expect-error - bindings issue
      MurmurService["MurmurRPC.V1"],
      "MurmurRPC.V1"
    );
    // @ts-expect-error - we know that this is a MurmurService client
    this.client = new MurmurClient(this.addr, credentials.createInsecure());
    return;
  }

  // Sets server to the first running one and returns server stream
  getServerStream(): Promise<ClientReadableStream<Server.Event>> {
    return new Promise((resolve) => {
      if (!this.client) {
        console.log("Murmur client connection null!");
        process.exit(1);
      }

      this.client.serverQuery(new Server.Query(), (e, r) => {
        if (!this.client) {
          console.log("Murmur client connection null!");
          process.exit(1);
        }

        if (e) {
          console.log(e);
          process.exit(1);
        } else if (r) {
          let server;
          for (const currentServer of r.getServersList()) {
            if (currentServer.getRunning()) {
              server = currentServer;
              break;
            }
          }

          if (!server) {
            console.log("No servers running!");
            process.exit(1);
            return;
          }

          this.server = server;
          resolve(this.client.serverEvents(this.server));
        }
      });
    });
  }

  async setupCallbacks(
    bridge: Bridge,
    roomLinks: RoomBridgeStore,
    config: MurmurConfig
  ): Promise<void> {
    const stream = await this.getServerStream();

    const getMatrixRooms = async (
      channelId?: number | Channel[]
    ): Promise<MatrixRoom[]> => {
      if (!channelId) {
        return [];
      }

      if (typeof channelId === "object") {
        let mtxRooms: MatrixRoom[] = [];
        for (const channel of channelId) {
          mtxRooms = mtxRooms.concat(
            await roomLinks.getLinkedMatrixRooms(String(channel.getId()))
          );
        }
        return mtxRooms;
      } else {
        return await roomLinks.getLinkedMatrixRooms(String(channelId));
      }
    };

    const eventCallback = async (event: Server.Event) => {
      {
        switch (event.getType()) {
          case Server.Event.Type.USERCONNECTED: {
            const connMtxRooms = await roomLinks.getEntriesByLinkData({
              send_join_part: JoinPartType.message,
            });
            if (!connMtxRooms.length) {
              break;
            }

            const connIntent = bridge.getIntent();
            for (const room of connMtxRooms) {
              const mtxId = room.matrix?.getId();
              if (!mtxId) {
                continue;
              }
              const userName =
                event.getUser()?.getName() || "[Bridge error: Unknown user]";
              void connIntent.sendMessage(mtxId, {
                body: `${userName} has connected to the server.`,
                msgtype: "m.notice",
              });
            }
            break;
          }
          case Server.Event.Type.USERDISCONNECTED: {
            const disconnMtxRooms = await roomLinks.getEntriesByLinkData({
              send_join_part: JoinPartType.message,
            });
            if (!disconnMtxRooms.length) {
              break;
            }

            const disconnIntent = bridge.getIntent();
            for (const room of disconnMtxRooms) {
              const mtxId = room.matrix?.getId();
              if (!mtxId) {
                continue;
              }
              const userName =
                event.getUser()?.getName() || "[Bridge error: Unknown user]";
              void disconnIntent.sendMessage(mtxId, {
                body: `${userName} "[Bridge error: No name]"} has disconnected from the server.`,
                msgtype: "m.notice",
              });
            }
            break;
          }
          case Server.Event.Type.USERTEXTMESSAGE: {
            const textMtxRooms = await getMatrixRooms(
              event.getMessage()?.getChannelsList()
            );
            if (!textMtxRooms.length) {
              break;
            }

            const userName = event.getUser()?.getName() || "err_unknown_user";
            const textIntent = bridge.getIntent(
              `@mumble_${userName}:${config.domain}`
            );
            for (const room of textMtxRooms) {
              void textIntent.sendMessage(room.getId(), {
                body: event.getMessage()?.getText(),
                format: "org.matrix.custom.html",
                formatted_body: event.getMessage()?.getText(),
                msgtype: "m.text",
              });
            }
            break;
          }
          default:
            break;
        }
        return;
      }
    };

    stream.on("data", (event: Server.Event) => void eventCallback(event));

    // stream.on error
    return;
  }

  setMatrixClient(client: MatrixClient): void {
    this.matrixClient = client;
    return;
  }

  // Matrix message -> Mumble
  sendMessage(
    event: WeakEvent,
    linkedRooms: number[],
    displayname?: string
  ): void {
    if (!this.client || !this.server || !this.matrixClient || !event.content) {
      return;
    }

    let messageContent =
      typeof event.content.body === "string" ? event.content.body : "";
    if (
      (event.content.msgtype === "m.image" ||
        event.content.msgtype === "m.file") &&
      typeof event.content.url === "string"
    ) {
      const url = this.matrixClient.mxcUrlToHttp(
        event.content.url,
        null,
        null,
        null,
        true
      );
      if (url) {
        messageContent = `<a href="${url}">${
          typeof event.content.body === "string" ? event.content.body : ""
        }</a>`;
      }
    }

    if (
      event.content.msgtype === "m.text" &&
      event.content.format === "org.matrix.custom.html" &&
      typeof event.content.formatted_body === "string"
    ) {
      messageContent = event.content.formatted_body;
    }

    // If displayname was not provided, fall back to username
    if (!displayname) {
      displayname = event.sender;
    }

    const message = new TextMessage();
    message.setServer(this.server);
    for (const roomId of linkedRooms) {
      message.addChannels(new Channel().setId(roomId));
    }
    message.setText(`${displayname}: ${messageContent}`);

    this.client.textMessageSend(message, () => {
      return;
    });

    return;
  }

  // Get Mumble channel id from channel name
  getChannelId(channelName: string): Promise<number | undefined> {
    const query = new Channel.Query();
    query.setServer(this.server);
    return new Promise((resolve) => {
      this.client?.channelQuery(query, (err, res) => {
        if (err) {
          console.error("Murmur channel lookup error:", err);
          resolve();
          return;
        }

        for (const channel of res.getChannelsList()) {
          if (channelName.trim() === channel.getName()?.trim()) {
            resolve(channel.getId());
            return;
          }
        }

        resolve();
      });
    });
  }
}
