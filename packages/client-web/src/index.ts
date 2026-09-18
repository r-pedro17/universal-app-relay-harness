import type { HarnessHandler, RegisterMessage, RpcRequest, RpcResponse, TestHarnessOptions } from "./types.js";

export type { HarnessHandler, TestHarnessOptions } from "./types.js";

export class TestHarness {
  private readonly handlers = new Map<string, HarnessHandler>();
  private readonly options: Required<Pick<TestHarnessOptions, "app" | "platform" | "reconnect" | "initialReconnectDelayMs" | "maxReconnectDelayMs">> & Pick<TestHarnessOptions, "token">;
  private readonly enabled: boolean;
  private socket: WebSocket | null = null;
  private hubUrl = "ws://127.0.0.1:4000";
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelayMs: number;
  private intentionallyClosed = false;

  constructor(options: TestHarnessOptions) {
    this.options = {
      app: options.app,
      platform: options.platform ?? "web",
      reconnect: options.reconnect ?? true,
      initialReconnectDelayMs: options.initialReconnectDelayMs ?? 100,
      maxReconnectDelayMs: options.maxReconnectDelayMs ?? 5000,
      token: options.token,
    };
    this.enabled = options.enabled ?? !isProductionEnvironment();
    this.reconnectDelayMs = this.options.initialReconnectDelayMs;
  }

  register(methodName: string, handler: HarnessHandler): void {
    if (!methodName.trim()) throw new Error("methodName must not be empty");
    this.handlers.set(methodName, handler);
    if (this.socket?.readyState === WebSocket.OPEN) this.sendRegistration();
  }

  connect(hubUrl = "ws://127.0.0.1:4000"): void {
    if (!this.enabled) return;
    this.hubUrl = hubUrl;
    this.intentionallyClosed = false;
    this.clearReconnectTimer();
    this.openSocket();
  }

  disconnect(): void {
    this.intentionallyClosed = true;
    this.clearReconnectTimer();
    this.socket?.close(1000, "Harness disconnected");
    this.socket = null;
  }

  private openSocket(): void {
    if (this.intentionallyClosed || !this.enabled) return;
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) return;

    const socket = new WebSocket(this.hubUrl);
    this.socket = socket;

    socket.addEventListener("open", () => {
      if (this.socket !== socket) return;
      this.reconnectDelayMs = this.options.initialReconnectDelayMs;
      this.sendRegistration();
    });

    socket.addEventListener("message", (event) => {
      if (this.socket !== socket || typeof event.data !== "string") return;
      void this.handleMessage(event.data);
    });

    socket.addEventListener("close", () => {
      if (this.socket === socket) this.socket = null;
      this.scheduleReconnect();
    });

    socket.addEventListener("error", () => {});
  }

  private async handleMessage(raw: string): Promise<void> {
    let request: RpcRequest;
    try {
      request = JSON.parse(raw) as RpcRequest;
    } catch {
      return;
    }

    if (!Number.isInteger(request.id) || typeof request.method !== "string") return;
    const handler = this.handlers.get(request.method);
    if (!handler) {
      this.sendResponse({
        id: request.id,
        error: { code: "METHOD_NOT_FOUND", message: `Unknown method '${request.method}'` },
      });
      return;
    }

    try {
      const result = await handler(request.params ?? {});
      this.sendResponse({ id: request.id, result, error: null });
    } catch (error) {
      this.sendResponse({
        id: request.id,
        error: {
          code: "HANDLER_ERROR",
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  private sendRegistration(): void {
    const message: RegisterMessage = {
      type: "register",
      app: this.options.app,
      platform: this.options.platform,
      methods: [...this.handlers.keys()].sort(),
      ...(this.options.token ? { token: this.options.token } : {}),
    };
    this.send(message);
  }

  private sendResponse(response: RpcResponse): void { this.send(response); }

  private send(payload: unknown): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(payload));
  }

  private scheduleReconnect(): void {
    if (this.intentionallyClosed || !this.options.reconnect || this.reconnectTimer) return;
    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, this.options.maxReconnectDelayMs);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket();
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (!this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }
}

function isProductionEnvironment(): boolean {
  const maybeProcess = (globalThis as typeof globalThis & {
    process?: { env?: { NODE_ENV?: string } };
  }).process;
  return maybeProcess?.env?.NODE_ENV === "production";
}
