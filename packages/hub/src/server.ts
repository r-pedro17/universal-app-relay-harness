import { createServer, type Server } from "node:http";
import { performance } from "node:perf_hooks";
import { acceptWebSocket, WebSocketConnection } from "./websocket.js";
import type {
  ConnectedApp,
  HarnessServerOptions,
  HubAddress,
  RegisterMessage,
  RpcRequest,
  RpcResponse,
} from "./types.js";

interface AppSession {
  info: ConnectedApp;
  socket: WebSocketConnection;
}

interface PendingCall {
  appId: string;
  startedAt: number;
  resolve: (value: { result: unknown; latencyMs: number }) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class HarnessServer {
  private readonly options: Required<Omit<HarnessServerOptions, "token">> & { token?: string };
  private server: Server | null = null;
  private address: HubAddress | null = null;
  private nextRequestId = 0;
  private readonly apps = new Map<string, AppSession>();
  private readonly pending = new Map<number, PendingCall>();
  private readonly connectedListeners = new Set<(app: ConnectedApp) => void>();
  private readonly disconnectedListeners = new Set<(app: ConnectedApp) => void>();

  constructor(options: HarnessServerOptions = {}) {
    this.options = {
      host: options.host ?? "127.0.0.1",
      port: options.port ?? 4000,
      requestTimeoutMs: options.requestTimeoutMs ?? 5000,
      registrationTimeoutMs: options.registrationTimeoutMs ?? 5000,
      maxPayloadBytes: options.maxPayloadBytes ?? 1024 * 1024,
      token: options.token,
    };
  }

  async start(): Promise<HubAddress> {
    if (this.server && this.address) return this.address;

    const server = createServer((_req, res) => {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("universal-app-relay-harness WebSocket hub\n");
    });

    server.on("upgrade", (request, socket) => {
      const connection = acceptWebSocket(request, socket, this.options.maxPayloadBytes);
      if (connection) this.awaitRegistration(connection);
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.options.port, this.options.host, () => {
        server.off("error", reject);
        resolve();
      });
    });

    const rawAddress = server.address();
    if (!rawAddress || typeof rawAddress === "string") {
      server.close();
      throw new Error("Hub did not receive a TCP address");
    }

    this.server = server;
    this.address = {
      host: this.options.host,
      port: rawAddress.port,
      url: `ws://${formatHost(this.options.host)}:${rawAddress.port}`,
    };
    return this.address;
  }

  async stop(): Promise<void> {
    for (const session of this.apps.values()) session.socket.close(1001, "Hub shutting down");
    this.apps.clear();

    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Hub stopped before the call completed"));
    }
    this.pending.clear();

    const server = this.server;
    this.server = null;
    this.address = null;
    if (!server) return;

    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  getAddress(): HubAddress | null { return this.address; }

  listApps(): ConnectedApp[] {
    return [...this.apps.values()].map(({ info }) => ({ ...info, methods: [...info.methods] }));
  }

  hasApp(appId: string): boolean { return this.apps.has(appId); }

  onAppConnected(listener: (app: ConnectedApp) => void): () => void {
    this.connectedListeners.add(listener);
    return () => this.connectedListeners.delete(listener);
  }

  onAppDisconnected(listener: (app: ConnectedApp) => void): () => void {
    this.disconnectedListeners.add(listener);
    return () => this.disconnectedListeners.delete(listener);
  }

  async waitForApp(appId?: string, timeoutMs = 5000): Promise<ConnectedApp> {
    const existing = appId ? this.apps.get(appId)?.info : this.listApps()[0];
    if (existing) return { ...existing, methods: [...existing.methods] };

    return new Promise<ConnectedApp>((resolve, reject) => {
      const timeout = setTimeout(() => {
        unsubscribe();
        reject(new Error(appId ? `Timed out waiting for app '${appId}'` : "Timed out waiting for an app"));
      }, timeoutMs);

      const unsubscribe = this.onAppConnected((app) => {
        if (appId && app.id !== appId) return;
        clearTimeout(timeout);
        unsubscribe();
        resolve({ ...app, methods: [...app.methods] });
      });
    });
  }

  async call(
    appId: string,
    method: string,
    params: unknown = {},
    timeoutMs = this.options.requestTimeoutMs,
  ): Promise<{ result: unknown; latencyMs: number }> {
    const session = this.apps.get(appId);
    if (!session) throw new Error(`App '${appId}' is not connected`);
    if (!session.info.methods.includes(method)) {
      throw new Error(`App '${appId}' does not advertise method '${method}'`);
    }

    const id = ++this.nextRequestId;
    const request: RpcRequest = { id, method, params };
    const startedAt = performance.now();

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Call '${method}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending.set(id, { appId, startedAt, resolve, reject, timer });
      try {
        session.socket.sendText(JSON.stringify(request));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private awaitRegistration(socket: WebSocketConnection): void {
    let registered = false;
    const registrationTimer = setTimeout(() => {
      if (!registered) socket.close(1008, "Registration timeout");
    }, this.options.registrationTimeoutMs);

    const unsubscribeMessage = socket.onMessage((raw) => {
      if (registered) return;

      let candidate: unknown;
      try {
        candidate = JSON.parse(raw);
      } catch {
        socket.close(1007, "Registration must be valid JSON");
        return;
      }

      if (!isRegisterMessage(candidate)) {
        socket.close(1008, "First message must be a valid register message");
        return;
      }

      if (this.options.token && candidate.token !== this.options.token) {
        socket.close(1008, "Invalid harness token");
        return;
      }

      registered = true;
      clearTimeout(registrationTimer);
      unsubscribeMessage();
      this.registerSession(socket, candidate);
    });

    socket.onClose(() => clearTimeout(registrationTimer));
  }

  private registerSession(socket: WebSocketConnection, registration: RegisterMessage): void {
    const existing = this.apps.get(registration.app);
    if (existing) existing.socket.close(1000, "Replaced by a newer connection");

    const info: ConnectedApp = {
      id: registration.app,
      platform: registration.platform,
      methods: [...new Set(registration.methods)].sort(),
      connectedAt: new Date().toISOString(),
    };

    const session: AppSession = { info, socket };
    this.apps.set(info.id, session);

    socket.onMessage((raw) => this.handleSessionMessage(session, raw));
    socket.onClose(() => this.unregisterSession(info.id, socket));

    for (const listener of this.connectedListeners) listener({ ...info, methods: [...info.methods] });
  }

  private unregisterSession(appId: string, socket: WebSocketConnection): void {
    const session = this.apps.get(appId);
    if (!session || session.socket !== socket) return;
    this.apps.delete(appId);

    for (const [id, pending] of this.pending) {
      if (pending.appId !== appId) continue;
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(new Error(`App '${appId}' disconnected before replying`));
    }

    for (const listener of this.disconnectedListeners) {
      listener({ ...session.info, methods: [...session.info.methods] });
    }
  }

  private handleSessionMessage(session: AppSession, raw: string): void {
    let message: unknown;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }

    if (isRegisterMessage(message)) {
      if (message.app !== session.info.id) {
        session.socket.close(1008, "Cannot change app id after registration");
        return;
      }
      if (this.options.token && message.token !== this.options.token) {
        session.socket.close(1008, "Invalid harness token");
        return;
      }
      session.info.platform = message.platform;
      session.info.methods = [...new Set(message.methods)].sort();
      return;
    }

    const response = message as RpcResponse;
    if (!Number.isInteger(response.id)) return;
    const pending = this.pending.get(response.id);
    if (!pending || pending.appId !== session.info.id) return;

    clearTimeout(pending.timer);
    this.pending.delete(response.id);

    if (response.error) {
      pending.reject(new Error(`${response.error.code}: ${response.error.message}`));
      return;
    }

    pending.resolve({ result: response.result, latencyMs: performance.now() - pending.startedAt });
  }
}

function isRegisterMessage(value: unknown): value is RegisterMessage {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<RegisterMessage>;
  return (
    candidate.type === "register" &&
    typeof candidate.app === "string" &&
    candidate.app.trim().length > 0 &&
    typeof candidate.platform === "string" &&
    Array.isArray(candidate.methods) &&
    candidate.methods.every((method) => typeof method === "string" && method.length > 0)
  );
}

function formatHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}
