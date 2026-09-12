// IRIS Messenger · © 2026 Sejun Ham (함세준) · MIT · https://feynman520.github.io/card/#home
// 확인용 1회성 SQL 실행기(운영자 전용). deploy.mjs 의 runSql(Management API)을 그대로 재사용.
// 사용: node scripts/sql.mjs "<sql>"
import { runSql } from '../hub/server/deploy.mjs';

const query = process.argv[2];
if (!query) { console.error('usage: node scripts/sql.mjs "<sql>"'); process.exit(2); }
const result = await runSql(query);
console.log(JSON.stringify(result, null, 2));
