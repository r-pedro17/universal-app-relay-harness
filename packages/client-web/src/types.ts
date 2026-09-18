export type HarnessHandler = (params: unknown) => Promise<unknown> | unknown;

export interface TestHarnessOptions {
  app: string;
  platform?: string;
  enabled?: boolean;
  token?: string;
  reconnect?: boolean;
  initialReconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
}

export interface RegisterMessage {
  type: "register";
  app: string;
  platform: string;
  methods: string[];
  token?: string;
}

export interface RpcRequest {
  id: number;
  method: string;
  params?: unknown;
}

export interface RpcResponse {
  id: number;
  result?: unknown;
  error?: {
    code: string;
    message: string;
    data?: unknown;
  } | null;
}
