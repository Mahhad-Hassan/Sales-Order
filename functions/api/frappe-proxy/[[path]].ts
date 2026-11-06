const BACKEND_ORIGIN = 'https://dev04.agrovisions.pk';
const PROXY_PREFIX = '/api/frappe-proxy';
const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const FRAPPE_COOKIE_NAMES = new Set([
  'csrf_token',
  'full_name',
  'preferred_language',
  'sid',
  'system_user',
  'user_id',
  'user_image',
  'user_lang',
]);
const HOP_BY_HOP_HEADERS = [
  'connection',
  'content-length',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
];

interface PagesRequestContext {
  request: Request;
}

export async function onRequest({ request }: PagesRequestContext): Promise<Response> {
  if (!ALLOWED_METHODS.has(request.method)) {
    return new Response('Method not allowed', {
      status: 405,
      headers: { Allow: [...ALLOWED_METHODS].join(', '), 'Cache-Control': 'no-store' },
    });
  }

  const incomingUrl = new URL(request.url);
  if (!incomingUrl.pathname.startsWith(`${PROXY_PREFIX}/`)) {
    return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
  }

  const apiPath = incomingUrl.pathname.slice(PROXY_PREFIX.length);
  if (!apiPath.startsWith('/api/')) {
    return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
  }

  const backendUrl = new URL(`${apiPath}${incomingUrl.search}`, BACKEND_ORIGIN);
  const headers = new Headers(request.headers);
  for (const header of HOP_BY_HOP_HEADERS) {
    headers.delete(header);
  }

  const frappeCookies = (request.headers.get('Cookie') ?? '')
    .split(';')
    .map((cookie) => cookie.trim())
    .filter((cookie) => {
      const separator = cookie.indexOf('=');
      return separator > 0 && FRAPPE_COOKIE_NAMES.has(cookie.slice(0, separator));
    });
  if (frappeCookies.length) {
    headers.set('Cookie', frappeCookies.join('; '));
  } else {
    headers.delete('Cookie');
  }

  const csrfToken = frappeCookies
    .find((cookie) => cookie.startsWith('csrf_token='))
    ?.slice('csrf_token='.length);
  if (csrfToken && !headers.has('X-Frappe-CSRF-Token')) {
    headers.set('X-Frappe-CSRF-Token', csrfToken);
  }

  let upstream: Response;
  try {
    upstream = await fetch(backendUrl, {
      method: request.method,
      headers,
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
      redirect: 'manual',
    });
  } catch {
    return Response.json(
      { error: 'Could not reach the Frappe backend.' },
      { status: 502, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  const responseHeaders = new Headers(upstream.headers);
  for (const header of HOP_BY_HOP_HEADERS) {
    responseHeaders.delete(header);
  }
  responseHeaders.delete('Set-Cookie');
  responseHeaders.set('Cache-Control', 'no-store');

  for (const cookie of upstream.headers.getSetCookie()) {
    responseHeaders.append(
      'Set-Cookie',
      cookie.replace(/;\s*Domain=[^;]*/i, ''),
    );
  }

  const bodylessStatus = [204, 205, 304].includes(upstream.status);
  return new Response(
    request.method === 'HEAD' || bodylessStatus ? null : upstream.body,
    {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    },
  );
}
