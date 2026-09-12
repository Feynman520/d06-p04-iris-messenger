// IRIS Messenger · © 2026 Sejun Ham (함세준) · MIT · https://feynman520.github.io/card/#home
// DPAPI(Windows Data Protection API, 현재 로그인 계정에 묶인 OS 암호화)로 바이트를 감싼다.
// PowerShell을 1회 호출해 stdin/stdout을 base64로 주고받는다. 비-Windows에서는 사용할 수 없다.
import { execFile } from 'node:child_process';
import path from 'node:path';

const PS_EXE = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const PROTECT_SCRIPT = "Add-Type -AssemblyName System.Security; $in=[Console]::In.ReadToEnd(); $b=[Convert]::FromBase64String($in); $o=[Security.Cryptography.ProtectedData]::Protect($b,$null,'CurrentUser'); [Console]::Out.Write([Convert]::ToBase64String($o))";
const UNPROTECT_SCRIPT = "Add-Type -AssemblyName System.Security; $in=[Console]::In.ReadToEnd(); $b=[Convert]::FromBase64String($in); $o=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser'); [Console]::Out.Write([Convert]::ToBase64String($o))";

function runPowerShell(script, inputB64) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      PS_EXE,
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { maxBuffer: 64 * 1024 * 1024, windowsHide: true, encoding: 'utf8' },
      (err, stdout) => {
        if (err) return reject(err);
        resolve(String(stdout).trim());
      },
    );
    child.stdin.end(inputB64);
  });
}

export async function protect(buf) {
  if (process.platform !== 'win32') throw new Error('DPAPI requires Windows');
  const out = await runPowerShell(PROTECT_SCRIPT, Buffer.from(buf).toString('base64'));
  return Buffer.from(out, 'base64');
}

export async function unprotect(buf) {
  if (process.platform !== 'win32') throw new Error('DPAPI requires Windows');
  const out = await runPowerShell(UNPROTECT_SCRIPT, Buffer.from(buf).toString('base64'));
  return Buffer.from(out, 'base64');
}

// 테스트 주입용: 실제 암호화 없이 그대로 통과시킨다(비-Windows CI, 단위 테스트에서 세션/신원 로직만 검증할 때).
export const dpapiPlain = { protect: async (b) => Buffer.from(b), unprotect: async (b) => Buffer.from(b) };
