// Localhost-only state bridge (spec §15.2): POST /v1/state, GET /v1/events (SSE),
// GET /v1/config, POST /v1/log, GET /v1/media/* (local playlist files).
// Listens on 127.0.0.1 exclusively — never 0.0.0.0.

import * as http from 'node:http';
import { createReadStream, statSync, type Stats } from 'node:fs';
import { extname, normalize } from 'node:path';
import type { AddressInfo } from 'node:net';

export interface BridgeSnapshot {
  state: string;
  config: unknown;
}

export interface StateServerOptions {
  port: number;
  onState: (state: string, harness?: string) => void;
  getSnapshot: () => BridgeSnapshot;
  onLog?: (line: string) => void;
  onError?: (err: Error) => void;
}

const MAX_BODY = 8 * 1024;

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
  '.mov': 'video/quicktime',
};

export class StateServer {
  private server: http.Server | null = null;
  private readonly clients = new Set<http.ServerResponse>();
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private mediaResolver: ((id: string) => string | null) | null = null;
  private port = 0;

  constructor(private readonly opts: StateServerOptions) {}

  get portBound(): number {
    return this.port;
  }

  setMediaResolver(fn: (id: string) => string | null): void {
    this.mediaResolver = fn;
  }

  start(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => this.handle(req, res));
      server.once('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          reject(new Error(`Vibe Terminal bridge port ${this.opts.port} is already in use (another VS Code window may own it).`));
        } else {
          reject(err);
        }
      });
      server.listen(this.opts.port, '127.0.0.1', () => {
        this.server = server;
        this.port = (server.address() as AddressInfo).port;
        this.heartbeat = setInterval(() => this.ping(), 15000);
        (this.heartbeat as { unref?: () => void }).unref?.();
        resolve(this.port);
      });
    });
  }

  broadcast(type: string, payload: Record<string, unknown>): void {
    const line = `data: ${JSON.stringify({ type, ...payload })}\n\n`;
    for (const client of this.clients) {
      try {
        client.write(line);
      } catch {
        this.clients.delete(client);
      }
    }
  }

  private ping(): void {
    for (const client of this.clients) {
      try {
        client.write(`: ping\n\n`);
      } catch {
        this.clients.delete(client);
      }
    }
  }

  async stop(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    for (const client of this.clients) {
      try {
        client.end();
      } catch {
        /* ignore */
      }
    }
    this.clients.clear();
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
      this.server = null;
    });
  }

  private cors(res: http.ServerResponse): void {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'content-type');
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    this.cors(res);
    const url = req.url || '/';

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === 'POST' && url.startsWith('/v1/state')) {
      this.readBody(req, (body) => {
        try {
          const parsed = JSON.parse(body || '{}') as { state?: unknown; harness?: unknown };
          const state = typeof parsed.state === 'string' ? parsed.state : '';
          const harness = typeof parsed.harness === 'string' ? parsed.harness.slice(0, 40) : undefined;
          if (state !== 'thinking' && state !== 'interactive') {
            res.writeHead(400);
            res.end();
            return;
          }
          this.opts.onState(state, harness);
          res.writeHead(204);
          res.end();
        } catch {
          res.writeHead(400);
          res.end();
        }
      });
      return;
    }

    if (req.method === 'POST' && url.startsWith('/v1/log')) {
      this.readBody(req, (body) => {
        if (body && this.opts.onLog) this.opts.onLog(body.slice(0, 2000));
        res.writeHead(204);
        res.end();
      });
      return;
    }

    if (req.method === 'GET' && url.startsWith('/v1/config')) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(this.opts.getSnapshot()));
      return;
    }

    if (req.method === 'GET' && url.startsWith('/v1/events')) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(`data: ${JSON.stringify({ type: 'snapshot', ...this.opts.getSnapshot() })}\n\n`);
      this.clients.add(res);
      const rport = req.socket.remotePort ?? 0;
      this.opts.onLog?.(`[bridge] sse client connected (total ${this.clients.size}, port ${rport})`);
      req.on('close', () => {
        this.clients.delete(res);
        this.opts.onLog?.(`[bridge] sse client closed (total ${this.clients.size}, port ${rport})`);
      });
      return;
    }

    if (url.startsWith('/v1/media/')) {
      const id = decodeURIComponent(url.slice('/v1/media/'.length).split('?')[0] || '');
      const filePath = this.mediaResolver ? this.mediaResolver(id) : null;
      if (!filePath || !isPathAllowed(filePath)) {
        res.writeHead(404);
        res.end();
        return;
      }
      try {
        serveMedia(req, res, filePath);
      } catch {
        res.writeHead(404);
        res.end();
      }
      return;
    }

    res.writeHead(404);
    res.end();
  }

  private readBody(req: http.IncomingMessage, cb: (body: string) => void): void {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      if (body.length < MAX_BODY) body += chunk.toString('utf8');
    });
    req.on('end', () => cb(body));
    req.on('error', () => cb(''));
  }
}

/** Media must come from an allow-listed path (registered playlist entries). */
let allowedMediaRoots: string[] = [];

export function setAllowedMediaRoots(roots: string[]): void {
  allowedMediaRoots = roots.map((r) => normalize(r).toLowerCase());
}

function isPathAllowed(filePath: string): boolean {
  const n = normalize(filePath).toLowerCase();
  return allowedMediaRoots.some((root) => n === root || n.startsWith(root.endsWith('\\') ? root : root + '\\'));
}

function serveMedia(req: http.IncomingMessage, res: http.ServerResponse, filePath: string): void {
  let stat: Stats;
  try {
    stat = statSync(filePath);
  } catch {
    res.writeHead(404);
    res.end();
    return;
  }
  const mime = MIME[extname(filePath).toLowerCase()] || 'application/octet-stream';
  const headers: Record<string, string> = {
    'Content-Type': mime,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache',
  };

  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (m) {
      const start = m[1] ? parseInt(m[1], 10) : 0;
      const end = m[2] ? parseInt(m[2], 10) : stat.size - 1;
      if (Number.isFinite(start) && Number.isFinite(end) && start <= end && start < stat.size) {
        const safeEnd = Math.min(end, stat.size - 1);
        headers['Content-Range'] = `bytes ${start}-${safeEnd}/${stat.size}`;
        headers['Content-Length'] = String(safeEnd - start + 1);
        res.writeHead(206, headers);
        if (req.method === 'HEAD') {
          res.end();
          return;
        }
        createReadStream(filePath, { start, end: safeEnd }).pipe(res);
        return;
      }
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
      res.end();
      return;
    }
  }

  headers['Content-Length'] = String(stat.size);
  res.writeHead(200, headers);
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(filePath).pipe(res);
}
