import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = normalize(join(fileURLToPath(new URL("../..", import.meta.url))));
const port = Number(process.env.DEMO_PORT ?? 4173);
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".map": "application/json" };

createServer(async (req, res) => {
  const pathname = new URL(req.url ?? "/", `http://${req.headers.host}`).pathname;
  const relative = pathname === "/" ? "/examples/web-demo/index.html" : pathname;
  const file = normalize(join(root, relative));
  if (!file.startsWith(root)) {
    res.writeHead(403).end("Forbidden");
    return;
  }
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error("not a file");
    res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" });
    createReadStream(file).pipe(res);
  } catch {
    res.writeHead(404).end("Not found");
  }
}).listen(port, "127.0.0.1", () => {
  console.log(`Web demo: http://127.0.0.1:${port}`);
});
