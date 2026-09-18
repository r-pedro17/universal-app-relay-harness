# universal-app-relay-harness

A lightweight, cross-platform, headless test harness and CLI bridge for testing application logic without driving the UI.

The key design is an **inverted local relay**: the hub runs on the developer machine, while web/native apps connect outward as WebSocket clients. That makes the same harness usable by browsers, iOS, Android, React Native, desktop apps, and any other client that can speak the wire protocol.

```text
Developer / test runner
          |
          v
+------------------------+
| Local App Relay Hub    |  ws://127.0.0.1:4000
+------------------------+
     ^              ^
     |              |
  Web app          iOS app
     |              |
     v              v
registered       registered
handlers         handlers
     |              |
     v              v
app state / business logic
```

This does not replace UI/end-to-end testing. It adds a fast inside-out layer for state, business logic, navigation intents, and other functionality an app deliberately exposes.

## Packages

- `@app-relay/hub` — local WebSocket hub, interactive CLI, and `HarnessRunner`.
- `@app-relay/client-web` — zero-runtime-dependency browser SDK using native `WebSocket`.
- `packages/client-ios` — Swift package using `URLSessionWebSocketTask`, networking only in `DEBUG`.

## Quick start

Requirements: Node.js 20+ and pnpm.

```bash
pnpm install
pnpm build
pnpm test
```

Start the hub:

```bash
pnpm harness
```

Start the web demo:

```bash
pnpm demo:web
```

Open `http://127.0.0.1:4173`.

The hub should report:

```text
Connected: [web-demo] (web) with methods: [cart.add, cart.clear, state.get]
```

Then use:

```text
harness> state.get {}
harness> cart.add {"id":"item_1","qty":1}
harness> state.get {}
```

With multiple apps:

```text
harness> :apps
harness> :use web-demo
```

## Wire protocol

Register:

```json
{
  "type": "register",
  "app": "my-web-store",
  "platform": "web",
  "methods": ["state.get", "cart.add", "auth.login"]
}
```

Invoke:

```json
{
  "id": 1,
  "method": "cart.add",
  "params": { "id": "prod_123", "qty": 1 }
}
```

Respond:

```json
{
  "id": 1,
  "result": { "success": true, "itemsCount": 1 },
  "error": null
}
```

## Web integration

```ts
import { TestHarness } from "@app-relay/client-web";

const harness = new TestHarness({ app: "my-web-store" });
harness.register("state.get", () => store.getState());
harness.register("cart.add", ({ id, qty }) => cart.add(id, qty));
harness.connect();
```

The client reconnects with exponential backoff. It disables itself by default when `NODE_ENV === "production"`. For bundlers that do not expose `NODE_ENV`, explicitly pass `enabled: false` in production or compile the harness initialization out.

## iOS integration

```swift
#if DEBUG
import AppRelayHarness

let harness = AppRelayHarness(appId: "my-ios-app")

harness.register(method: "state.get") { _ in
    ["screen": "home"]
}

harness.connect(to: "ws://127.0.0.1:4000")
#endif
```

## Programmatic runner

```js
import { HarnessRunner } from "@app-relay/hub";

const runner = new HarnessRunner({ port: 0, appId: "my-app" });
const address = await runner.connect();

// Launch/connect your app to address.url.
await runner.waitForApp();
await runner.call("cart.add", { id: "prod_123", qty: 1 });
const state = await runner.call("state.get");

await runner.close();
```

The included `node:test` suite starts a hub, connects a headless app client, dispatches `cart.add`, verifies state, and enforces a default 10ms local round-trip budget.

## Security

This is developer/test tooling, not a production control plane.

- The hub binds to loopback by default.
- The web SDK is disabled in production by default when `NODE_ENV` is available.
- The iOS SDK performs networking only in `DEBUG`.
- Only expose narrow test methods; do not register arbitrary code execution.
- Use `HARNESS_TOKEN` if the hub must bind beyond loopback.

## What remains app-specific

The transport, protocol, hub, CLI, and runner are generic. The bindings are app-specific:

```text
"state.get"  -> your state store
"cart.add"   -> your cart service
"auth.login" -> your auth test adapter
```

That separation is the point: the harness never needs to understand your business logic.
