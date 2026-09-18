import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const DEFAULT_MAX_PAYLOAD = 1024 * 1024;

export class WebSocketConnection {
  private buffer = Buffer.alloc(0);
  private closed = false;
  private readonly messageListeners = new Set<(text: string) => void>();
  private readonly closeListeners = new Set<() => void>();

  constructor(
    private readonly socket: Duplex,
    private readonly maxPayloadBytes = DEFAULT_MAX_PAYLOAD,
  ) {
    socket.on("data", (chunk: Buffer) => {
      try {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        this.drainFrames();
      } catch {
        this.close(1002, "Invalid WebSocket frame");
      }
    });
    socket.on("close", () => this.emitClose());
    socket.on("end", () => this.emitClose());
    socket.on("error", () => this.emitClose());
  }

  onMessage(listener: (text: string) => void): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  sendText(text: string): void {
    if (this.closed) throw new Error("WebSocket is closed");
    this.socket.write(encodeFrame(0x1, Buffer.from(text, "utf8")));
  }

  close(code = 1000, reason = ""): void {
    if (this.closed) return;
    this.closed = true;
    const reasonBuffer = Buffer.from(reason, "utf8");
    const payload = Buffer.allocUnsafe(2 + Math.min(reasonBuffer.length, 123));
    payload.writeUInt16BE(code, 0);
    reasonBuffer.copy(payload, 2, 0, payload.length - 2);
    try {
      this.socket.write(encodeFrame(0x8, payload));
    } finally {
      this.socket.end();
      this.emitClose();
    }
  }

  private drainFrames(): void {
    while (true) {
      const parsed = decodeClientFrame(this.buffer, this.maxPayloadBytes);
      if (!parsed) return;
      this.buffer = this.buffer.subarray(parsed.bytesConsumed);

      if (!parsed.fin) {
        this.close(1003, "Fragmented frames are not supported");
        return;
      }

      switch (parsed.opcode) {
        case 0x1:
          for (const listener of this.messageListeners) listener(parsed.payload.toString("utf8"));
          break;
        case 0x8:
          this.close();
          return;
        case 0x9:
          this.socket.write(encodeFrame(0xA, parsed.payload));
          break;
        case 0xA:
          break;
        default:
          this.close(1003, "Unsupported frame opcode");
          return;
      }
    }
  }

  private emitClose(): void {
    if (!this.closed) this.closed = true;
    if (this.closeListeners.size === 0) return;
    const listeners = [...this.closeListeners];
    this.closeListeners.clear();
    for (const listener of listeners) listener();
  }
}

interface ParsedFrame {
  fin: boolean;
  opcode: number;
  payload: Buffer;
  bytesConsumed: number;
}

function decodeClientFrame(buffer: Buffer, maxPayloadBytes: number): ParsedFrame | null {
  if (buffer.length < 2) return null;

  const first = buffer[0];
  const second = buffer[1];
  const fin = (first & 0x80) !== 0;
  const opcode = first & 0x0f;
  const masked = (second & 0x80) !== 0;
  let payloadLength = second & 0x7f;
  let offset = 2;

  if (!masked) throw new Error("Client WebSocket frames must be masked");

  if (payloadLength === 126) {
    if (buffer.length < offset + 2) return null;
    payloadLength = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (payloadLength === 127) {
    if (buffer.length < offset + 8) return null;
    const value = buffer.readBigUInt64BE(offset);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Payload is too large");
    payloadLength = Number(value);
    offset += 8;
  }

  if (payloadLength > maxPayloadBytes) throw new Error(`Payload exceeds ${maxPayloadBytes} bytes`);
  if (buffer.length < offset + 4 + payloadLength) return null;

  const mask = buffer.subarray(offset, offset + 4);
  offset += 4;
  const payload = Buffer.from(buffer.subarray(offset, offset + payloadLength));
  for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];

  return { fin, opcode, payload, bytesConsumed: offset + payloadLength };
}

function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length;
  let header: Buffer;

  if (length < 126) {
    header = Buffer.allocUnsafe(2);
    header[1] = length;
  } else if (length <= 0xffff) {
    header = Buffer.allocUnsafe(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }

  header[0] = 0x80 | opcode;
  return Buffer.concat([header, payload]);
}

export function acceptWebSocket(
  request: IncomingMessage,
  socket: Duplex,
  maxPayloadBytes = DEFAULT_MAX_PAYLOAD,
): WebSocketConnection | null {
  const upgrade = request.headers.upgrade?.toLowerCase();
  const connection = request.headers.connection?.toLowerCase();
  const key = request.headers["sec-websocket-key"];
  const version = request.headers["sec-websocket-version"];

  if (
    upgrade !== "websocket" ||
    !connection?.split(",").some((part) => part.trim() === "upgrade") ||
    typeof key !== "string" ||
    version !== "13"
  ) {
    socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return null;
  }

  const accept = createHash("sha1").update(key + WEBSOCKET_GUID).digest("base64");
  socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "\r\n",
    ].join("\r\n"),
  );

  return new WebSocketConnection(socket, maxPayloadBytes);
}
