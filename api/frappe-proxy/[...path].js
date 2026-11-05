const FRAPPE_BACKEND_URL = process.env.FRAPPE_BACKEND_URL;
const PROXY_PREFIX = '/api/frappe-proxy';
const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const FORWARDED_REQUEST_HEADERS = [
  'accept',
  'authorization',
  'content-type',
  'cookie',
  'origin',
  'referer',
  'x-frappe-csrf-token',
];
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'content-encoding',
  'content-length',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

module.exports = async function handler(request, response) {
  if (!ALLOWED_METHODS.has(request.method)) {
    response.setHeader('Allow', [...ALLOWED_METHODS].join(', '));
    response.status(405).end();
    return;
  }

  if (!FRAPPE_BACKEND_URL) {
    response.status(500).json({ error: 'Frappe backend URL is not configured.' });
    return;
  }

  let backend;
  try {
    backend = new URL(FRAPPE_BACKEND_URL);
  } catch {
    response.status(500).json({ error: 'Frappe backend URL is invalid.' });
    return;
  }

  if (
    backend.protocol !== 'https:'
    || backend.username
    || backend.password
    || (backend.pathname !== '/' && backend.pathname !== '')
    || backend.search
    || backend.hash
  ) {
    response.status(500).json({ error: 'Frappe backend URL must be an HTTPS origin.' });
    return;
  }

  let incoming;
  try {
    incoming = new URL(request.url, 'https://vercel.invalid');
  } catch {
    response.status(400).end();
    return;
  }

  const frappePath = incoming.pathname.slice(PROXY_PREFIX.length);
  if (
    !incoming.pathname.startsWith(`${PROXY_PREFIX}/`)
    || (!frappePath.startsWith('/api/method/') && !frappePath.startsWith('/api/resource/'))
  ) {
    response.status(404).end();
    return;
  }

  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers[name];
    if (typeof value === 'string') {
      headers.set(name, value);
    }
  }

  const csrfToken = request.headers.cookie?.match(/(?:^|;\s*)csrf_token=([^;]*)/)?.[1];
  if (csrfToken && !headers.has('x-frappe-csrf-token')) {
    headers.set('x-frappe-csrf-token', csrfToken);
  }

  let body;
  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && request.body !== undefined) {
    body = typeof request.body === 'string' || Buffer.isBuffer(request.body)
      ? request.body
      : JSON.stringify(request.body);
    if (typeof request.body === 'object' && !Buffer.isBuffer(request.body) && !headers.has('content-type')) {
      headers.set('content-type', 'application/json');
    }
  }

  try {
    const upstream = await fetch(
      `${backend.origin}${frappePath}${incoming.search}`,
      {
        method: request.method,
        headers,
        body,
        redirect: 'manual',
      },
    );

    response.status(upstream.status);
    response.setHeader('Cache-Control', 'no-store');
    for (const [name, value] of upstream.headers) {
      if (
        name !== 'set-cookie'
        && name.toLowerCase() !== 'cache-control'
        && !HOP_BY_HOP_HEADERS.has(name.toLowerCase())
      ) {
        response.setHeader(name, value);
      }
    }

    const cookies = upstream.headers.getSetCookie();
    if (cookies.length) {
      response.setHeader(
        'set-cookie',
        cookies.map((cookie) => cookie.replace(/;\s*domain=[^;]*/i, '')),
      );
    }

    response.end(Buffer.from(await upstream.arrayBuffer()));
  } catch {
    response.status(502).json({ error: 'Could not reach the Frappe backend.' });
  }
};

module.exports.config = {
  api: {
    bodyParser: {
      sizeLimit: '1mb',
    },
  },
};
