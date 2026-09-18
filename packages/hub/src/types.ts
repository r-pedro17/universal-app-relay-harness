export type Platform = "web" | "ios" | "android" | "react-native" | "desktop" | string;

export interface RegisterMessage {
  type: "register";
  app: string;
  platform: Platform;
  methods: string[];
  token?: string;
}

export interface RpcRequest {
  id: number;
  method: string;
  params?: unknown;
}

export interface RpcError {
  code: string;
  message: string;
  data?: unknown;
}

export interface RpcResponse {
  id: number;
  result?: unknown;
  error?: RpcError | null;
}

export interface ConnectedApp {
  id: string;
  platform: Platform;
  methods: string[];
  connectedAt: string;
}

export interface HubAddress {
  host: string;
  port: number;
  url: string;
}

export interface HarnessServerOptions {
  host?: string;
  port?: number;
  requestTimeoutMs?: number;
  registrationTimeoutMs?: number;
  token?: string;
  maxPayloadBytes?: number;
}
