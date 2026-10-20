// Minimal local server: `npm start`, then open http://localhost:5173.
// The site is fully static, so any static host (GitHub Pages, Netlify, …) works for deployment too.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT ?? 5173);

// Allowlist: only the site's own files are served (never tests, package.json or this script).
const PUBLIC_PATH = /^\/(index\.html|styles\.css|src\/(messages\/)?[\w-]+\.js)$/;

const MIME_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
});

const SECURITY_HEADERS = Object.freeze({
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
});

function send(response, status, message) {
  response.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' });
  response.end(message);
}

async function handleRequest(request, response) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return send(response, 405, 'Method Not Allowed');

  let pathname;
  try {
    ({ pathname } = new URL(request.url ?? '/', `http://${HOST}`));
  } catch {
    return send(response, 400, 'Bad Request');
  }
  const path = pathname === '/' ? '/index.html' : pathname;
  if (!PUBLIC_PATH.test(path)) return send(response, 404, 'Not Found');

  try {
    const body = await readFile(join(ROOT, path));
    response.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': MIME_TYPES[extname(path)],
      'Cache-Control': 'no-cache',
    });
    response.end(request.method === 'HEAD' ? undefined : body);
  } catch (error) {
    if (error?.code === 'ENOENT') return send(response, 404, 'Not Found');
    console.error(`Failed to serve ${path}:`, error);
    send(response, 500, 'Internal Server Error');
  }
}

createServer(handleRequest).listen(PORT, HOST, () => {
  process.stdout.write(`MaxUpload running at http://localhost:${PORT}\n`);
});
