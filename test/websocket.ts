import * as assert from 'assert';
import { AddressInfo } from 'net';
import { WebSocketServer } from 'ws';
import { FireFlyWebSocket } from '../lib/websocket';

// These are private, but there is no other way to simulate a handler that was still in flight
// when the socket was closed, or to guarantee a socket is down at the end of a test.
type SocketInternals = {
  options: { reconnectDelay: number };
  reconnectTimer?: NodeJS.Timeout;
  reconnect(msg: string): void;
};

const internals = (socket: FireFlyWebSocket) => socket as unknown as SocketInternals;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('websocket', () => {
  const reconnectDelay = 100;

  let server: WebSocketServer;
  let sockets: FireFlyWebSocket[];
  let upgradeAttempts: number;
  let acceptConnections: boolean;
  let previousLogLevel: string | undefined;

  beforeEach(async () => {
    // Logger reads the level when it is constructed, so this has to happen before any socket
    previousLogLevel = process.env.FF_SDK_LOG_LEVEL;
    process.env.FF_SDK_LOG_LEVEL = 'NONE';

    sockets = [];
    upgradeAttempts = 0;
    acceptConnections = false;
    server = new WebSocketServer({
      port: 0,
      verifyClient: (info, cb) => {
        upgradeAttempts++;
        // Rejecting sends a 401, so the attempt reaches the unexpected-response handler
        // that the SDK reconnects from
        acceptConnections ? cb(true) : cb(false, 401, 'Unauthorized', {});
      },
    });
    await new Promise<void>((resolve) => server.on('listening', resolve));
  });

  afterEach(async () => {
    // close() should stop a socket reconnecting on its own. Disabling reconnection here
    // too means that if it ever stops doing so, the test fails its assertion instead of
    // leaving a socket retrying against a closed port, which hangs the whole run.
    for (const socket of sockets) {
      const socketInternals = internals(socket);
      socketInternals.options.reconnectDelay = -1;
      if (socketInternals.reconnectTimer) {
        clearTimeout(socketInternals.reconnectTimer);
        delete socketInternals.reconnectTimer;
      }
      await socket.close();
    }
    process.env.FF_SDK_LOG_LEVEL = previousLogLevel;
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  function newSocket() {
    const { port } = server.address() as AddressInfo;
    const socket = new FireFlyWebSocket(
      {
        host: `ws://127.0.0.1:${port}`,
        namespace: 'ns',
        subscriptions: [],
        reconnectDelay,
        heartbeatInterval: 30000,
        ephemeral: { namespace: 'ns', filter: { events: 'x' } },
      },
      () => {},
    );
    sockets.push(socket);
    return socket;
  }

  async function waitForAttempts(count: number) {
    const deadline = Date.now() + 2000;
    while (upgradeAttempts < count && Date.now() < deadline) {
      await delay(5);
    }
    assert.ok(
      upgradeAttempts >= count,
      `expected at least ${count} connection attempts, saw ${upgradeAttempts}`,
    );
  }

  it('reconnects when the peer drops the connection', async () => {
    acceptConnections = true;
    let dropped = false;
    server.on('connection', (peer) => {
      if (!dropped) {
        dropped = true;
        peer.terminate();
      }
    });

    newSocket();

    // A second attempt is the socket coming back after the drop
    await waitForAttempts(2);
  });

  it('does not reconnect after close() when a reconnect is already pending', async () => {
    const socket = newSocket();

    // A second attempt means the first rejection scheduled a reconnect. Closing half a
    // backoff later puts us in the state an application is in when it closes a socket that
    // has been failing - the connection is down and the SDK is waiting to retry it.
    await waitForAttempts(2);
    await delay(reconnectDelay / 2);
    await socket.close();

    // The socket is closed, so the server should see no further connection attempts
    const attemptsAtClose = upgradeAttempts;
    await delay(reconnectDelay * 5);
    assert.strictEqual(
      upgradeAttempts - attemptsAtClose,
      0,
      'socket kept reconnecting after close()',
    );
  });

  it('does not reconnect when an in-flight handler reconnects after close()', async () => {
    const socket = newSocket();
    await waitForAttempts(1);
    await socket.close();

    // unexpected-response reconnects from a deferred stream flush, so a rejection that was
    // still being drained when we closed lands after the close has completed
    const attemptsAtClose = upgradeAttempts;
    internals(socket).reconnect('FireFly connect error [401]');
    await delay(reconnectDelay * 5);
    assert.strictEqual(upgradeAttempts - attemptsAtClose, 0, 'socket reconnected after close()');
  });
});
