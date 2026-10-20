import http, { type IncomingMessage, type OutgoingHttpHeaders } from "node:http";
import type { Socket } from "node:net";

export function localReviewUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    || url.username || url.password || !url.port || Number(url.port) < 1024) {
    throw new Error("Plannotator phone links require a localhost review server.");
  }
  return url;
}

export function authorized(req: IncomingMessage, login: string, origin: string): boolean {
  return req.headers["tailscale-user-login"] === login
    && (!req.headers.origin || req.headers.origin === origin);
}

export async function createReviewProxy(reviewUrl: string, identity: { hostname: string; login: string }) {
  const target = localReviewUrl(reviewUrl);
  const upstreamOrigin = `http://localhost:${target.port}`;
  const sockets = new Set<Socket>();
  let origin = "";
  const headers = (req: IncomingMessage): OutgoingHttpHeaders => {
    const result: OutgoingHttpHeaders = { ...req.headers, host: `localhost:${target.port}` };
    if (result.origin) result.origin = upstreamOrigin;
    if (result.referer) result.referer = `${upstreamOrigin}/`;
    for (const key of Object.keys(result)) {
      if (key.startsWith("tailscale-") || key.startsWith("x-forwarded-")) delete result[key];
    }
    return result;
  };
  const server = http.createServer((req, res) => {
    if (!authorized(req, identity.login, origin)) {
      res.writeHead(403); res.end("This review is private to this machine's Tailscale owner."); return;
    }
    const upstream = http.request({ hostname: "127.0.0.1", port: target.port, path: req.url, method: req.method, headers: headers(req) }, (answer) => {
      res.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(res);
    });
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end("The Plannotator review has closed or is unavailable.");
    });
    req.on("aborted", () => upstream.destroy());
    res.on("close", () => upstream.destroy());
    req.pipe(upstream);
  });
  server.on("connection", (socket) => {
    sockets.add(socket); socket.once("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (req, socket, head) => {
    if (!authorized(req, identity.login, origin)) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); return;
    }
    const upstream = http.request({ hostname: "127.0.0.1", port: target.port, path: req.url, method: req.method, headers: headers(req) });
    upstream.on("upgrade", (answer, peer, peerHead) => {
      sockets.add(peer); peer.once("close", () => sockets.delete(peer));
      socket.write(`HTTP/1.1 ${answer.statusCode} ${answer.statusMessage}\r\n`);
      for (let i = 0; i < answer.rawHeaders.length; i += 2) socket.write(`${answer.rawHeaders[i]}: ${answer.rawHeaders[i + 1]}\r\n`);
      socket.write("\r\n");
      if (peerHead.length) socket.write(peerHead);
      if (head.length) peer.write(head);
      socket.on("error", () => peer.destroy()); peer.on("error", () => socket.destroy());
      socket.on("close", () => peer.destroy()); peer.on("close", () => socket.destroy());
      socket.pipe(peer).pipe(socket);
    });
    upstream.on("response", (answer) => {
      answer.resume(); socket.end(`HTTP/1.1 ${answer.statusCode ?? 502} Review unavailable\r\nConnection: close\r\n\r\n`);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("close", () => upstream.destroy());
    upstream.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject); server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as { port: number }).port;
  origin = `https://${identity.hostname}:${port}`;
  const url = new URL(target); url.protocol = "https:"; url.hostname = identity.hostname; url.port = String(port);
  let closing: Promise<void> | undefined;
  return {
    port, url: url.href,
    close: () => closing ??= new Promise<void>((resolve) => {
      server.close(() => resolve());
      for (const socket of sockets) socket.destroy();
    }),
  };
}
