/**
 * Node harness used by the test-suite: runs the exact same app as the Worker on
 * top of node:sqlite and a plain http server.
 */
import http from 'node:http';
import { createApp } from './app.ts';
import { bindDatabase, initDatabase } from './db.ts';
import { createNodeDriver } from './sql-driver.node.ts';

export async function createServer(databasePath = process.env.DATABASE_PATH || ':memory:') {
  bindDatabase(createNodeDriver(databasePath));
  initDatabase();
  const app = createApp();

  const server = http.createServer(async (nodeReq, nodeRes) => {
    const chunks: Buffer[] = [];
    for await (const chunk of nodeReq) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    const headers = new Headers();
    for (const [key, value] of Object.entries(nodeReq.headers)) {
      if (Array.isArray(value)) value.forEach((v) => headers.append(key, v));
      else if (value !== undefined) headers.set(key, value);
    }
    const request = new Request(`http://${nodeReq.headers.host}${nodeReq.url}`, {
      method: nodeReq.method,
      headers,
      body: nodeReq.method === 'GET' || nodeReq.method === 'HEAD' || body.length === 0 ? undefined : body,
    });
    const response = await app.fetch(request);
    const outHeaders: Record<string, string | string[]> = {};
    response.headers.forEach((value, key) => {
      if (key !== 'set-cookie') outHeaders[key] = value;
    });
    const cookies = response.headers.getSetCookie();
    if (cookies.length) outHeaders['set-cookie'] = cookies;
    nodeRes.writeHead(response.status, outHeaders);
    nodeRes.end(Buffer.from(await response.arrayBuffer()));
  });

  return { app, server };
}
