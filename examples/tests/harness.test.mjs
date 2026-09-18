import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { HarnessRunner } from "../../packages/hub/dist/index.js";

let runner;
let appSocket;
let state;

before(async () => {
  runner = new HarnessRunner({ port: 0, appId: "test-web-app" });
  const address = await runner.connect();
  state = { cart: [] };

  appSocket = new WebSocket(address.url);
  appSocket.addEventListener("open", () => {
    appSocket.send(JSON.stringify({
      type: "register",
      app: "test-web-app",
      platform: "web",
      methods: ["state.get", "cart.add", "cart.clear"]
    }));
  });

  appSocket.addEventListener("message", (event) => {
    const request = JSON.parse(event.data);
    let result;
    let error = null;

    if (request.method === "state.get") {
      result = structuredClone(state);
    } else if (request.method === "cart.add") {
      const item = { id: request.params.id, qty: request.params.qty ?? 1 };
      state.cart.push(item);
      result = { success: true, itemsCount: state.cart.length };
    } else if (request.method === "cart.clear") {
      state.cart.length = 0;
      result = { success: true, itemsCount: 0 };
    } else {
      error = { code: "METHOD_NOT_FOUND", message: request.method };
    }

    appSocket.send(JSON.stringify({ id: request.id, result, error }));
  });

  await runner.waitForApp("test-web-app");
});

after(async () => {
  appSocket?.close();
  await runner?.close();
});

test("registers a connected app and exposes its methods", () => {
  const apps = runner.listApps();
  assert.equal(apps.length, 1);
  assert.equal(apps[0].id, "test-web-app");
  assert.deepEqual(apps[0].methods, ["cart.add", "cart.clear", "state.get"]);
});

test("dispatches cart.add and observes updated state", async () => {
  await runner.call("cart.clear");
  const { result, latencyMs } = await runner.callTimed("cart.add", { id: "item_1", qty: 1 });
  assert.deepEqual(result, { success: true, itemsCount: 1 });

  const current = await runner.call("state.get");
  assert.deepEqual(current, { cart: [{ id: "item_1", qty: 1 }] });

  const budgetMs = Number(process.env.HARNESS_LATENCY_BUDGET_MS ?? 10);
  assert.ok(latencyMs < budgetMs, `Expected cart.add round-trip under ${budgetMs}ms, got ${latencyMs.toFixed(2)}ms`);
});

test("fails early when a method was not advertised", async () => {
  await assert.rejects(() => runner.call("auth.login", {}), /does not advertise method/);
});
