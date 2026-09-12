// IRIS Messenger · © 2026 Sejun Ham (함세준) · MIT · https://feynman520.github.io/card/#home
// 허브 배포(운영자 전용): 마이그레이션 SQL 적용 → Auth(OTP 6자리·10분·SMTP·메일 틀) → anon key 를 module/hub.json 에 기록.
// 사용: node hub/server/deploy.mjs [--env <secrets .env 경로>] [--no-auth] [--dry]
// 이 파일은 import 만으로는 아무 일도 하지 않는다(읽기·검사·종료는 전부 main() 또는 호출 시점에).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };

// 이 저장소 저자의 개인 경로(다른 운영자에게는 없다 — 없으면 저장소 루트 .env 로 내려간다).
const IRIS_ENV = path.join(process.env.CLAUDE_CONFIG_DIR || 'C:/IRIS/_agent/claude', 'secrets', '.env');
let envOverride = null; // --env 로 지정한 경로(main 에서만 설정)

export function readEnv(p) {
  const out = {};
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m) out[m[1]] = m[2].trim().replace(/^"|"$/g, '');
  }
  return out;
}

// 운영자마다 비밀 파일 위치가 다르다: --env → IRIS_MESSENGER_ENV → 저자 기본 경로 → 저장소 루트 .env.
export function envFile(override = null) {
  const given = override || envOverride || process.env.IRIS_MESSENGER_ENV;
  if (given) return given;
  if (fs.existsSync(IRIS_ENV)) return IRIS_ENV;
  return path.join(root, '.env');
}

/** { env, file } — 파일이 없거나 읽히지 않으면 env 는 빈 객체이고, file 로 "어디를 봤는지"를 알린다. */
export function loadEnv(override = null) {
  const file = envFile(override);
  let env = {};
  try { env = readEnv(file); } catch { env = {}; }
  return { env, file };
}

export const hubRef = () => JSON.parse(fs.readFileSync(path.join(here, 'hub-ref.json'), 'utf8'));

// Management API PAT: 일반 이름이 먼저, 계정별 이름(SUPABASE_ACCESS_TOKEN_<account>)이 그 다음.
function pat() {
  const { env, file } = loadEnv();
  const ref = hubRef();
  const key = env.SUPABASE_ACCESS_TOKEN || env[`SUPABASE_ACCESS_TOKEN_${ref.account || ''}`];
  if (!key) throw new Error(`SUPABASE_ACCESS_TOKEN${ref.account ? ` (또는 SUPABASE_ACCESS_TOKEN_${ref.account})` : ''} missing in ${file}`);
  return key;
}

async function call(method, p, body) {
  const ref = hubRef();
  const r = await fetch(`https://api.supabase.com/v1/projects/${ref.ref}${p}`, {
    method,
    headers: { Authorization: `Bearer ${pat()}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${p} → ${r.status} ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : null;
}
export async function runSql(query) { return call('POST', '/database/query', { query }); }

async function main() {
  const dry = args.includes('--dry');
  envOverride = opt('--env');
  const ref = hubRef();
  const { env, file } = loadEnv();
  try { pat(); } catch (e) { console.error(e.message); process.exit(2); }
  console.log(`env: ${file}`);
  // 1) 마이그레이션(파일명 순, meta.migrations 에 적용 목록 기록)
  const dir = path.join(here, 'migrations');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
  let applied = [];
  try { const r = await runSql(`select value from public.meta where key = 'migrations'`); applied = r[0] ? JSON.parse(r[0].value) : []; } catch {}
  for (const f of files) {
    if (applied.includes(f)) { console.log(`skip ${f}`); continue; }
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    if (dry) { console.log(`would apply ${f} (${sql.length} chars)`); continue; }
    await runSql(sql);
    applied.push(f);
    await runSql(`insert into public.meta(key, value) values ('migrations', '${JSON.stringify(applied).replace(/'/g, "''")}') on conflict (key) do update set value = excluded.value`);
    console.log(`applied ${f}`);
  }
  // 2) Auth 설정
  if (!args.includes('--no-auth') && !dry) {
    const tpl = fs.readFileSync(path.join(here, 'email-otp.html'), 'utf8');
    const from = env.IRIS_MESSENGER_MAIL_FROM; // 예: iris@example.com — Resend 에 검증된 도메인이어야 함
    const hasSmtp = !!(from && env.RESEND_API_KEY);
    const cfg = {
      mailer_otp_length: 6, mailer_otp_exp: 600,
      rate_limit_verify: 30, rate_limit_otp: 30,
      external_anonymous_users_enabled: false, mailer_autoconfirm: false, disable_signup: false,
    };
    // 메일 틀·제목·rate_limit_email_sent·smtp_sender_name 은 커스텀 SMTP 없이는 Management API가 거부한다(실측:
    // 401 "Custom SMTP required to configure SMTP_SENDER_NAME or RATE_LIMIT_EMAIL_SENT", 400 "Email template
    // modification is not available for free tier projects using the default email provider") → SMTP 없을 때는
    // 이 키들을 전부 빼고 Supabase 기본 메일(팀원 전용, 시간당 몇 통)로 남긴다.
    if (hasSmtp) Object.assign(cfg, {
      mailer_subjects_magic_link: 'IRIS 메신저 로그인 코드', mailer_subjects_confirmation: 'IRIS 메신저 로그인 코드',
      mailer_templates_magic_link_content: tpl, mailer_templates_confirmation_content: tpl,
      rate_limit_email_sent: 60,
      smtp_host: 'smtp.resend.com', smtp_port: '465', smtp_user: 'resend', smtp_pass: env.RESEND_API_KEY, smtp_admin_email: from, smtp_sender_name: 'IRIS Messenger', smtp_max_frequency: 30,
    });
    else console.warn('IRIS_MESSENGER_MAIL_FROM/RESEND_API_KEY missing → Supabase built-in mail (team members only, few per hour); mailer template/subject/rate_limit_email_sent left at defaults');
    await call('PATCH', '/config/auth', cfg);
    console.log('auth config updated' + (cfg.smtp_host ? ` (smtp=${cfg.smtp_host}, from=${from})` : ' (built-in mail, defaults)'));
  }
  // 3) anon key → module/hub.json
  const keys = await call('GET', '/api-keys?reveal=true');
  const anon = keys.find(k => k.name === 'anon')?.api_key;
  if (!anon) throw new Error('anon key not found');
  const hub = { url: ref.url, anonKey: anon, schema: 1 };
  if (!dry) fs.writeFileSync(path.join(root, 'module', 'hub.json'), JSON.stringify(hub, null, 2) + '\n');
  console.log(`module/hub.json ${dry ? 'would be' : ''} written (url=${ref.url})`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(e => { console.error(e.message); process.exit(1); });
