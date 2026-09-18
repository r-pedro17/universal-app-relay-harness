import { TestHarness } from "/packages/client-web/dist/index.js";

const state = { cart: [] };
const stateNode = document.querySelector("#state");

function render() {
  stateNode.textContent = JSON.stringify(state, null, 2);
}

function addItem({ id = `item_${state.cart.length + 1}`, qty = 1 } = {}) {
  const item = { id, qty };
  state.cart.push(item);
  render();
  return { success: true, itemsCount: state.cart.length, item };
}

function clearCart() {
  state.cart.length = 0;
  render();
  return { success: true, itemsCount: 0 };
}

const harness = new TestHarness({ app: "web-demo" });
harness.register("state.get", () => structuredClone(state));
harness.register("cart.add", (params) => addItem(params));
harness.register("cart.clear", () => clearCart());
harness.connect();

document.querySelector("#add").addEventListener("click", () => addItem({}));
document.querySelector("#clear").addEventListener("click", clearCart);
render();
