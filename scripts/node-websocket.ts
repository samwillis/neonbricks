import WebSocket from "ws";
// The Node harness uses ws so the SDK can force-terminate a close handshake.
// Node 22's built-in browser-compatible socket can keep a CLI process alive.
globalThis.WebSocket = WebSocket as unknown as typeof globalThis.WebSocket;
