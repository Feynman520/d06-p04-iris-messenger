// IRIS Messenger · © 2026 Sejun Ham (함세준) · MIT · https://feynman520.github.io/card/#home
// 테스트 전용 가짜 허브: node:http로 GoTrue/PostgREST/Storage 최소 동작을 흉내낸다.
import { createServer } from 'node:http';

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(body);
}

export async function startMock() {
  const calls = { otp: [], verify: [], refresh: [], insert: [], rpc: [], upload: [], profilePatch: [] };
  const store = new Map(); // bucket/path -> Buffer
  store.profile = null; // single fake profiles row (id 'u1')

  const server = createServer(async (req, res) => {
    const u = new URL(req.url, 'http://localhost');
    const path = u.pathname;
    const method = req.method;
    const raw = await readBody(req);
    let body = null;
    if (raw.length) { try { body = JSON.parse(raw.toString('utf8')); } catch { body = raw; } }

    if (method === 'POST' && path === '/auth/v1/otp') {
      calls.otp.push(body);
      return sendJson(res, 200, {});
    }

    if (method === 'POST' && path === '/auth/v1/verify') {
      calls.verify.push(body);
      if (body?.type === 'magiclink') {
        if (body.token_hash === 'hash-ok') {
          return sendJson(res, 200, { access_token: 'at1', refresh_token: 'rt1', expires_in: 3600, user: { id: 'u1', email: body.email } });
        }
        return sendJson(res, 400, { error_code: 'otp_expired', msg: 'Token has expired or is invalid' });
      }
      if (body?.token === '123456') {
        return sendJson(res, 200, { access_token: 'at1', refresh_token: 'rt1', expires_in: 3600, user: { id: 'u1', email: body.email } });
      }
      return sendJson(res, 400, { error_code: 'otp_expired', msg: 'Token has expired or is invalid' });
    }

    if (method === 'POST' && path === '/auth/v1/token' && u.searchParams.get('grant_type') === 'refresh_token') {
      calls.refresh.push(body);
      return sendJson(res, 200, { access_token: 'at2', refresh_token: 'rt2', expires_in: 3600, user: { id: 'u1' } });
    }

    if (method === 'POST' && path === '/auth/v1/logout') {
      res.writeHead(204);
      return res.end();
    }

    if (method === 'GET' && path === '/rest/v1/things') {
      if (req.headers.authorization === 'Bearer at-old') return sendJson(res, 401, { message: 'JWT expired' });
      return sendJson(res, 200, [{ id: 1 }]);
    }

    if (method === 'POST' && path === '/rest/v1/things') {
      calls.insert.push(body);
      if (body?.client_id === 'dup') return sendJson(res, 409, { code: '23505', message: 'duplicate' });
      const prefer = req.headers.prefer || '';
      if (prefer.includes('return=representation')) return sendJson(res, 201, [{ ...body }]);
      res.writeHead(201);
      return res.end();
    }

    if (method === 'POST' && path === '/rest/v1/rpc/echo') {
      calls.rpc.push(body);
      return sendJson(res, 200, body);
    }

    if (method === 'POST' && path === '/rest/v1/rpc/delete_me') {
      calls.rpc.push(body);
      return sendJson(res, 200, {});
    }

    if (method === 'GET' && path === '/rest/v1/profiles') {
      const idParam = u.searchParams.get('id') || ''; // 'eq.u1'
      const id = idParam.startsWith('eq.') ? idParam.slice(3) : null;
      if (!store.profile || store.profile.id !== id) return sendJson(res, 200, []);
      const selectParam = u.searchParams.get('select');
      const fields = selectParam ? selectParam.split(',') : Object.keys(store.profile);
      const row = {};
      for (const f of fields) row[f] = store.profile[f];
      return sendJson(res, 200, [row]);
    }

    if (method === 'POST' && path === '/rest/v1/profiles') {
      store.profile = { ...body };
      const prefer = req.headers.prefer || '';
      if (prefer.includes('return=representation')) return sendJson(res, 201, [store.profile]);
      res.writeHead(201);
      return res.end();
    }

    if (method === 'PATCH' && path === '/rest/v1/profiles') {
      const idParam = u.searchParams.get('id') || '';
      calls.profilePatch.push({ id: idParam, body });
      if (store.profile) Object.assign(store.profile, body);
      return sendJson(res, 200, [body]);
    }

    const uploadMatch = path.match(/^\/storage\/v1\/object\/([^/]+)\/(.+)$/);
    if (uploadMatch) {
      const [, bucket, objPath] = uploadMatch;
      const key = `${bucket}/${objPath}`;
      if (method === 'POST') {
        calls.upload.push({ bucket, objPath, bytes: raw.length });
        store.set(key, raw);
        return sendJson(res, 200, { Key: key });
      }
      if (method === 'GET') {
        const data = store.get(key);
        if (!data) return sendJson(res, 404, { message: 'not found' });
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        return res.end(data);
      }
    }

    sendJson(res, 404, { message: `no route for ${method} ${path}` });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}`;
  return {
    url, calls, store,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
