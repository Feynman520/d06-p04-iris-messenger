// IRIS Messenger · © 2026 Sejun Ham (함세준) · MIT · https://feynman520.github.io/card/#home
// 운영 일일 점검: ① Storage `files` 버킷의 90일 지난 파일 정리(배치 100개씩) ② 무료 한도(DB 500MB·Storage 1GB·가입자 50,000) 대비 사용률 보고, 80% 초과 시 stderr WARN
// ③ --cleanup 이면 pg_cron 없는 허브를 위해 select public.cleanup()을 대신 호출. 사용: node hub/server/ops/daily.mjs [--dry] [--cleanup]
// 자세한 절차는 hub/server/운영.md ③항 참고. service role key(SUPABASE_SERVICE_ROLE_KEY_IRIS_MESSENGER)는 secrets .env 에서만 읽는다.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readEnv, runSql } from '../deploy.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ref = JSON.parse(fs.readFileSync(path.join(here, '..', 'hub-ref.json'), 'utf8'));
const HUB_URL = ref.url;

const secretsPath = path.join(process.env.CLAUDE_CONFIG_DIR || 'C:/IRIS/_agent/claude', 'secrets', '.env');
const secrets = readEnv(secretsPath);
const SERVICE_ROLE_KEY = secrets.SUPABASE_SERVICE_ROLE_KEY_IRIS_MESSENGER;
if (!SERVICE_ROLE_KEY) { console.error('SUPABASE_SERVICE_ROLE_KEY_IRIS_MESSENGER missing in ' + secretsPath); process.exit(2); }

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const doCleanup = args.includes('--cleanup');

const CAPS = { db: 500 * 1024 * 1024, storage: 1 * 1024 * 1024 * 1024, users: 50000 };
const BATCH = 100;

function formatBytes(n) {
  const mb = n / 1024 / 1024;
  return mb > 1024 ? `${(mb / 1024).toFixed(2)}GB` : `${mb.toFixed(1)}MB`;
}
function report(label, value, cap, fmt) {
  const pct = Math.floor((value / cap) * 1000) / 10;
  const line = `${label}: ${fmt(value)} / ${fmt(cap)} (${pct}%)`;
  if (pct > 80) console.error(`WARN ${line}`); else console.log(line);
}
async function storageDelete(prefixes) {
  const r = await fetch(`${HUB_URL}/storage/v1/object/files`, {
    method: 'DELETE',
    headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefixes }),
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`DELETE /storage/v1/object/files → ${r.status} ${t.slice(0, 300)}`);
  return t ? JSON.parse(t) : null;
}

async function main() {
  console.log(`IRIS Messenger ops:daily — ${new Date().toISOString()}${dry ? ' (--dry)' : ''}`);

  // ① Storage 90일 지난 파일 정리
  const rows = await runSql(`select name from storage.objects where bucket_id = 'files' and created_at < now() - interval '90 days' order by name`);
  const names = rows.map((r) => r.name);
  console.log(`storage cleanup: ${names.length} file(s) older than 90 days`);
  if (names.length) {
    if (dry) {
      console.log(`  (dry run — would delete; first 10) ${names.slice(0, 10).join(', ')}${names.length > 10 ? ' …' : ''}`);
    } else {
      for (let i = 0; i < names.length; i += BATCH) {
        const batch = names.slice(i, i + BATCH);
        await storageDelete(batch);
        console.log(`  deleted batch ${Math.floor(i / BATCH) + 1}: ${batch.length} file(s)`);
      }
    }
  }

  // ② 한도 사용률 보고
  const [dbRow] = await runSql(`select pg_database_size(current_database()) as size`);
  const [stRow] = await runSql(`select coalesce(sum((metadata->>'size')::bigint), 0) as size from storage.objects`);
  const [userRow] = await runSql(`select count(*) as n from auth.users`);
  report('DB 크기', Number(dbRow.size), CAPS.db, formatBytes);
  report('Storage 크기', Number(stRow.size), CAPS.storage, formatBytes);
  report('가입자 수', Number(userRow.n), CAPS.users, String);

  // ③ --cleanup: pg_cron 없는 허브 대신 청소 함수를 직접 호출
  if (doCleanup) {
    if (dry) {
      console.log('cleanup: (dry run — public.cleanup() 호출 생략)');
    } else {
      const [result] = await runSql(`select * from public.cleanup()`);
      console.log(`cleanup: messages_deleted=${result.messages_deleted} invites_deleted=${result.invites_deleted} attempts_deleted=${result.attempts_deleted}`);
    }
  }
}
main().catch((e) => { console.error(e.message); process.exit(1); });
