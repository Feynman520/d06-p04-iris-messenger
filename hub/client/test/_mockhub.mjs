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
  const calls = { otp: [], verify: [], refresh: [], insert: [], rpc: [], upload: [], profilePatch: [], invite: [] };
  const store = new Map(); // bucket/path -> Buffer
  store.profile = null; // single fake profiles row (id 'u1')
  store.profiles = []; // other users' profiles rows, for GET id=in.(...) (contacts.mjs sync)
  store.contacts = []; // fake contacts rows: { user_a, user_b, status, requested_by, blocked_by }
  store.invites = new Map(); // code -> { owner_id, display_name, public_key, key_version }
  store.acceptStatus = 'pending'; // forced accept_invite() status: pending|accepted|rate_limited|invalid|blocked

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

    // ---- contacts.mjs: 연락처 4종 rpc + contacts/profiles 조회 흉내 ----

    if (method === 'POST' && path === '/rest/v1/rpc/create_invite') {
      calls.invite.push({ fn: 'create_invite', args: body });
      const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      let code = '';
      for (let i = 0; i < 8; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)];
      store.invites.set(code, {
        owner_id: 'u1',
        display_name: store.profile?.display_name ?? null,
        public_key: store.profile?.public_key ?? null,
        key_version: store.profile?.key_version ?? null,
      });
      return sendJson(res, 200, code);
    }

    if (method === 'POST' && path === '/rest/v1/rpc/lookup_invite') {
      calls.invite.push({ fn: 'lookup_invite', args: body });
      const code = String(body?.p_code || '').toUpperCase();
      const inv = store.invites.get(code);
      if (!inv) return sendJson(res, 200, []);
      return sendJson(res, 200, [{ owner_id: inv.owner_id, display_name: inv.display_name, public_key: inv.public_key, key_version: inv.key_version }]);
    }

    if (method === 'POST' && path === '/rest/v1/rpc/accept_invite') {
      calls.invite.push({ fn: 'accept_invite', args: body });
      const code = String(body?.p_code || '').toUpperCase();
      const inv = store.invites.get(code);
      const status = store.acceptStatus || 'pending';
      const me = 'u1';
      if (status !== 'pending' && status !== 'accepted') {
        return sendJson(res, 200, [{ other_id: inv?.owner_id ?? null, status }]);
      }
      if (!inv) return sendJson(res, 200, [{ other_id: null, status: 'invalid' }]);
      const a = me < inv.owner_id ? me : inv.owner_id;
      const b = me < inv.owner_id ? inv.owner_id : me;
      if (!store.contacts.some((r) => r.user_a === a && r.user_b === b)) {
        store.contacts.push({ user_a: a, user_b: b, status: 'pending', requested_by: me, blocked_by: null });
      }
      return sendJson(res, 200, [{ other_id: inv.owner_id, status }]);
    }

    if (method === 'POST' && path === '/rest/v1/rpc/respond_contact') {
      calls.invite.push({ fn: 'respond_contact', args: body });
      const me = 'u1';
      const other = body?.p_other;
      const action = body?.p_action;
      const a = me < other ? me : other;
      const b = me < other ? other : me;
      const idx = store.contacts.findIndex((r) => r.user_a === a && r.user_b === b);
      if (idx < 0) return sendJson(res, 400, { message: 'no such contact' });
      const row = store.contacts[idx];
      let result;
      if (action === 'accept') { row.status = 'accepted'; result = 'accepted'; }
      else if (action === 'reject') { store.contacts.splice(idx, 1); result = 'deleted'; }
      else if (action === 'remove') { store.contacts.splice(idx, 1); result = 'deleted'; }
      else if (action === 'block') { row.status = 'blocked'; row.blocked_by = me; result = 'blocked'; }
      else if (action === 'unblock') { row.status = 'accepted'; row.blocked_by = null; result = 'accepted'; }
      else return sendJson(res, 400, { message: 'unknown action' });
      return sendJson(res, 200, result);
    }

    if (method === 'GET' && path === '/rest/v1/contacts') {
      return sendJson(res, 200, store.contacts);
    }

    if (method === 'GET' && path === '/rest/v1/profiles') {
      const idParam = u.searchParams.get('id') || ''; // 'eq.u1' or 'in.(u2,u3)'
      const selectParam = u.searchParams.get('select');
      if (idParam.startsWith('in.(')) {
        const ids = idParam.slice(4, -1).split(',').filter(Boolean);
        const fields = selectParam ? selectParam.split(',') : null;
        const rows = store.profiles.filter((p) => ids.includes(p.id));
        const out = fields ? rows.map((p) => { const r = {}; for (const f of fields) r[f] = p[f]; return r; }) : rows;
        return sendJson(res, 200, out);
      }
      const id = idParam.startsWith('eq.') ? idParam.slice(3) : null;
      if (!store.profile || store.profile.id !== id) return sendJson(res, 200, []);
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
