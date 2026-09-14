import { IncomingMessage } from 'http';
import { Transform } from 'stream';
import * as WebSocket from 'ws';
import {
  FireFlyEphemeralSubscription,
  FireFlyWebSocketOptions,
  FireFlyEventDelivery,
  FireFlyEventBatchDelivery,
} from './interfaces';
import Logger from './logger';

function buildEphemeralQueryParams(sub: FireFlyEphemeralSubscription) {
  const params = new URLSearchParams();
  params.append('ephemeral', 'true');
  params.append('namespace', sub.namespace);
  if (sub.filter?.events !== undefined) {
    params.append('filter.events', sub.filter.events);
  }
  return params.toString();
}

export interface FireFlyWebSocketCallback {
  (
    socket: FireFlyWebSocket,
    data: FireFlyEventDelivery | FireFlyEventBatchDelivery,
  ): void | Promise<void>;
}

export class FireFlyWebSocket {
  private readonly logger = new Logger(FireFlyWebSocket.name);

  private socket?: WebSocket;
  private closed? = () => {};
  private pingTimer?: NodeJS.Timeout;
  private disconnectTimer?: NodeJS.Timeout;
  private reconnectTimer?: NodeJS.Timeout;
  private disconnectDetected = false;
  private closing = false;

  constructor(
    private options: FireFlyWebSocketOptions,
    private callback: FireFlyWebSocketCallback,
  ) {
    this.connect();
  }

  private connect() {
    // Ensure we've cleaned up any old socket. close() clears the reconnect timer and marks
    // us as closing, so clear that flag again now we are re-opening.
    this.close();
    this.closing = false;

    let url = `${this.options.host}/ws`;
    if (this.options.ephemeral !== undefined) {
      url += '?' + buildEphemeralQueryParams(this.options.ephemeral);
    }

    const auth =
      this.options.username && this.options.password
        ? `${this.options.username}:${this.options.password}`
        : undefined;
    const socket = (this.socket = new WebSocket(url, {
      ...this.options.socketOptions,
      auth,
      handshakeTimeout: this.options.heartbeatInterval,
    }));
    this.closed = undefined;

    socket
      .on('open', () => {
        if (this.disconnectDetected) {
          this.disconnectDetected = false;
          this.logger.log('Connection restored');
        } else {
          this.logger.log('Connected');
        }
        this.schedulePing();
        for (const name of this.options.subscriptions) {
          socket.send(
            JSON.stringify({
              type: 'start',
              autoack: this.options.autoack,
              namespace: this.options.namespace,
              name,
            }),
          );
          this.logger.log(`Started listening on subscription ${this.options.namespace}:${name}`);
        }
        if (this.options?.afterConnect !== undefined) {
          this.options.afterConnect(this);
        }
      })
      .on('error', (err) => {
        this.logger.error('Error', err.stack);
      })
      .on('close', () => {
        if (this.closed) {
          this.logger.log('Closed');
          this.closed(); // do this after all logging
        } else {
          this.disconnectDetected = true;
          this.reconnect('Closed by peer');
        }
      })
      .on('pong', () => {
        this.logger.debug(`WS received pong`);
        this.schedulePing();
      })
      .on('unexpected-response', (req, res: IncomingMessage) => {
        let responseData = '';
        res.pipe(
          new Transform({
            transform(chunk, encoding, callback) {
              responseData += chunk;
              callback();
            },
            flush: () => {
              this.reconnect(`FireFly connect error [${res.statusCode}]: ${responseData}`);
            },
          }),
        );
      })
      .on('message', (data: string) => {
        const event: FireFlyEventDelivery = JSON.parse(data);
        this.callback(this, event);
      });
  }

  private clearPingTimers() {
    if (this.disconnectTimer) {
      clearTimeout(this.disconnectTimer);
      delete this.disconnectTimer;
    }
    if (this.pingTimer) {
      clearTimeout(this.pingTimer);
      delete this.pingTimer;
    }
  }

  private schedulePing() {
    this.clearPingTimers();
    this.disconnectTimer = setTimeout(
      () => this.reconnect('Heartbeat timeout'),
      Math.ceil(this.options.heartbeatInterval * 1.5), // 50% grace period
    );
    this.pingTimer = setTimeout(() => {
      this.logger.debug(`WS sending ping`);
      this.socket?.ping('ping', true, (err) => {
        if (err) this.reconnect(err.message);
      });
    }, this.options.heartbeatInterval);
  }

  private reconnect(msg: string) {
    // A handler that was already in flight when close() was called must not be able to
    // bring the socket back - unexpected-response in particular reconnects from a deferred
    // stream flush, which can land after the close has completed.
    if (this.closing) {
      return;
    }
    if (!this.reconnectTimer) {
      this.close();
      this.logger.error(`Websocket closed: ${msg}`);
      if (this.options.reconnectDelay === -1) {
        // do not attempt to reconnect
      } else {
        this.reconnectTimer = setTimeout(() => this.connect(), this.options.reconnectDelay);
      }
    }
  }

  send(json: JSON) {
    if (this.socket !== undefined) {
      this.socket.send(JSON.stringify(json));
    }
  }

  ack(event: FireFlyEventDelivery | FireFlyEventBatchDelivery) {
    if (this.socket !== undefined && event.id !== undefined) {
      this.socket.send(
        JSON.stringify({
          type: 'ack',
          id: event.id,
          subscription: event.subscription,
        }),
      );
    }
  }

  async close(wait?: boolean): Promise<void> {
    const closedPromise = new Promise<void>((resolve) => {
      this.closed = resolve;
    });
    // Closing is final until connect() is called again. Without this, a reconnect that was
    // already scheduled still fires, and a caller that has dropped its reference to this
    // socket has no way left to stop it retrying.
    this.closing = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      delete this.reconnectTimer;
    }
    this.clearPingTimers();
    if (this.socket) {
      try {
        this.socket.close();
      } catch (e: any) {
        this.logger.warn(`Failed to clean up websocket: ${e.message}`);
      }
      if (wait) await closedPromise;
      this.socket = undefined;
    }
  }
}
