// IRIS Messenger · © 2026 Sejun Ham (함세준) · MIT · https://feynman520.github.io/card/#home
// 허브 배포(운영자 전용): 마이그레이션 SQL 적용 → Auth(OTP 6자리·10분·SMTP·메일 틀) → anon key 를 module/hub.json 에 기록.
// 사용: node hub/server/deploy.mjs [--env <secrets .env 경로>] [--no-auth] [--dry]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const envPath = opt('--env') || path.join(process.env.CLAUDE_CONFIG_DIR || 'C:/IRIS/_agent/claude', 'secrets', '.env');

export function readEnv(p) {
  const out = {};
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m) out[m[1]] = m[2].trim().replace(/^"|"$/g, '');
  }
  return out;
}
const env = readEnv(envPath);
const ref = JSON.parse(fs.readFileSync(path.join(here, 'hub-ref.json'), 'utf8'));
const PAT = env.SUPABASE_ACCESS_TOKEN_FEYNMAN520;
if (!PAT) { console.error('SUPABASE_ACCESS_TOKEN_FEYNMAN520 missing in ' + envPath); process.exit(2); }
const API = `https://api.supabase.com/v1/projects/${ref.ref}`;
const H = { Authorization: `Bearer ${PAT}`, 'Content-Type': 'application/json' };

async function call(method, p, body) {
  const r = await fetch(API + p, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${p} → ${r.status} ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : null;
}
export async function runSql(query) { return call('POST', '/database/query', { query }); }

async function main() {
  const dry = args.includes('--dry');
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
