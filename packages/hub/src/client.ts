import { HarnessServer } from "./server.js";
import type { ConnectedApp, HarnessServerOptions, HubAddress } from "./types.js";

export interface HarnessRunnerOptions extends HarnessServerOptions {
  appId?: string;
}

export class HarnessRunner {
  readonly server: HarnessServer;
  private preferredAppId?: string;

  constructor(options: HarnessRunnerOptions = {}) {
    this.preferredAppId = options.appId;
    this.server = new HarnessServer(options);
  }

  async connect(): Promise<HubAddress> { return this.server.start(); }
  async close(): Promise<void> { await this.server.stop(); }
  listApps(): ConnectedApp[] { return this.server.listApps(); }
  use(appId: string): void { this.preferredAppId = appId; }

  async waitForApp(appId = this.preferredAppId, timeoutMs = 5000): Promise<ConnectedApp> {
    const app = await this.server.waitForApp(appId, timeoutMs);
    if (!this.preferredAppId) this.preferredAppId = app.id;
    return app;
  }

  async call<T = unknown>(method: string, params: unknown = {}, appId = this.preferredAppId): Promise<T> {
    const target = appId ?? this.resolveSingleApp();
    const { result } = await this.server.call(target, method, params);
    return result as T;
  }

  async callTimed<T = unknown>(
    method: string,
    params: unknown = {},
    appId = this.preferredAppId,
  ): Promise<{ result: T; latencyMs: number }> {
    const target = appId ?? this.resolveSingleApp();
    const response = await this.server.call(target, method, params);
    return { result: response.result as T, latencyMs: response.latencyMs };
  }

  private resolveSingleApp(): string {
    const apps = this.server.listApps();
    if (apps.length === 0) throw new Error("No app is connected");
    if (apps.length > 1) throw new Error("Multiple apps are connected. Select one with runner.use(appId).");
    return apps[0].id;
  }
}
