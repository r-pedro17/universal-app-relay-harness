#!/usr/bin/env node
import process from "node:process";
import readline from "node:readline";
import { inspect } from "node:util";
import { HarnessServer } from "./server.js";

interface CliOptions {
  host: string;
  port: number;
  appId?: string;
  token?: string;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const server = new HarnessServer({ host: options.host, port: options.port, token: options.token });
  let selectedAppId = options.appId;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "harness> " });

  server.onAppConnected((app) => {
    console.log(`\nConnected: [${app.id}] (${app.platform}) with methods: [${app.methods.join(", ")}]`);
    if (!selectedAppId && server.listApps().length === 1) selectedAppId = app.id;
    rl.prompt(true);
  });

  server.onAppDisconnected((app) => {
    console.log(`\nDisconnected: [${app.id}]`);
    if (selectedAppId === app.id) selectedAppId = undefined;
    rl.prompt(true);
  });

  const address = await server.start();
  console.log(`App Relay Hub listening on ${address.url}`);
  console.log("Commands: <method> <json_params>, :apps, :use <app>, :help, :quit");
  rl.prompt();

  rl.on("line", async (line) => {
    const input = line.trim();
    if (!input) return rl.prompt();

    try {
      if (input === ":quit" || input === ":exit") {
        rl.close();
        return;
      }
      if (input === ":help") {
        printHelp();
        return rl.prompt();
      }
      if (input === ":apps") {
        const apps = server.listApps();
        if (apps.length === 0) console.log("No apps connected.");
        for (const app of apps) {
          const marker = app.id === selectedAppId ? "*" : " ";
          console.log(`${marker} ${app.id} (${app.platform}) [${app.methods.join(", ")}]`);
        }
        return rl.prompt();
      }
      if (input.startsWith(":use ")) {
        const appId = input.slice(5).trim();
        if (!server.hasApp(appId)) throw new Error(`App '${appId}' is not connected`);
        selectedAppId = appId;
        console.log(`Using [${appId}]`);
        return rl.prompt();
      }

      const firstSpace = input.indexOf(" ");
      const method = firstSpace === -1 ? input : input.slice(0, firstSpace);
      const paramsText = firstSpace === -1 ? "{}" : input.slice(firstSpace + 1).trim();
      const params = paramsText ? JSON.parse(paramsText) : {};
      const apps = server.listApps();
      const target = selectedAppId ?? (apps.length === 1 ? apps[0].id : undefined);
      if (!target) {
        throw new Error(apps.length === 0 ? "No app is connected" : "Multiple apps connected. Use ':use <app>'.");
      }

      const { result, latencyMs } = await server.call(target, method, params);
      console.log(`<- [${latencyMs.toFixed(1)}ms] ${inspect(result, { depth: null, colors: process.stdout.isTTY })}`);
    } catch (error) {
      console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
    rl.prompt();
  });

  rl.on("close", async () => {
    await server.stop();
    process.exitCode = 0;
  });
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    host: process.env.HOST ?? "127.0.0.1",
    port: Number(process.env.PORT ?? 4000),
    token: process.env.HARNESS_TOKEN,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];
    if (arg === "--port" && next) {
      options.port = Number(next);
      index += 1;
    } else if (arg === "--host" && next) {
      options.host = next;
      index += 1;
    } else if (arg === "--app" && next) {
      options.appId = next;
      index += 1;
    } else if (arg === "--token" && next) {
      options.token = next;
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      console.log("Usage: app-relay [--host 127.0.0.1] [--port 4000] [--app APP_ID] [--token TOKEN]");
      process.exit(0);
    } else {
      throw new Error(`Unknown argument '${arg}'`);
    }
  }

  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
    throw new Error("Port must be an integer between 0 and 65535");
  }
  return options;
}

function printHelp(): void {
  console.log([
    "<method> <json_params>  Call a method on the selected app",
    ":apps                   List connected apps",
    ":use <app>              Select the target app",
    ":help                   Show this help",
    ":quit                   Stop the hub",
  ].join("\n"));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
