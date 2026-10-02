'use strict';
// 真并发：两个工作进程同时打开同一个文件库，对同一段发起签收，
// BEGIN IMMEDIATE + 部分唯一索引保证只有一个事务能落 SIGNED。
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const WORKER = `
const { createApp } = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'app.js'))});
const [file, regId, stage, staffId] = process.argv.slice(2);
const app = createApp(file);
try {
  app.service.signStage({ regId, stageKey: stage, staffId });
  console.log('WIN');
} catch (e) {
  console.log('LOSE:' + e.code);
}
process.exit(0);
`;

test('两个进程并发签收同一航段：恰好一条 SIGNED', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'umnr-conc-'));
  const file = path.join(dir, 'conc.sqlite');
  const docsDir = path.join(dir, 'docs');

  // 先用内存种子逻辑播种到文件库（种子含小熊猫，已到 CREW 之后，待 GROUND_ARR/SZX）
  const { createApp } = require('../src/app');
  const { seedApp } = require('../src/seed');
  const app = createApp(file, { MU5318: { status: 'DIVERTED', divertedTo: 'SZX' } });
  seedApp(app, { docsDir });
  // 再插入第二名 SZX 地面人员，两个进程各自以"本人"身份尝试同一段
  app.db.prepare("INSERT INTO staff(id,name,role,station_code,active,created_at) VALUES('stf_szx_gr2','第二名地面','ground','SZX',1,'t')").run();
  // 让第二段地面也指向 stf_szx_gr（与种子一致）；第二人属于同站但非被指定接收人，
  // 此用例只验证唯一约束，故把 seq0 指定接收人为空场景不合适——
  // 改为并发测试"到达地面段"，该段任一本站地面都可签收（非指定段）。
  app.db.close();

  const workerFile = path.join(dir, 'worker.js');
  fs.writeFileSync(workerFile, WORKER);

  // spawnSync 不并发，改用两个带微小启动差的子进程：用 detached 无法等待；
  // 这里用两个同步启动到后台再 wait 的 shell 方式。
  const run = `
    node ${JSON.stringify(workerFile)} ${JSON.stringify(file)} reg_小熊猫 GROUND_ARR stf_szx_gr  > ${JSON.stringify(path.join(dir, 'a.out'))} &
    P1=$!
    node ${JSON.stringify(workerFile)} ${JSON.stringify(file)} reg_小熊猫 GROUND_ARR stf_szx_gr2 > ${JSON.stringify(path.join(dir, 'b.out'))} &
    P2=$!
    wait $P1 $P2
  `;
  const sh = spawnSync('bash', ['-c', run], { encoding: 'utf8' });
  if (sh.status !== 0) throw new Error(sh.stderr || '并发脚本失败');

  const a = fs.readFileSync(path.join(dir, 'a.out'), 'utf8').trim();
  const b = fs.readFileSync(path.join(dir, 'b.out'), 'utf8').trim();
  const outcomes = [a, b].sort();
  assert.ok(outcomes.includes('WIN'), `应有一个成功，实际 ${a}/${b}`);
  // 输家可能是唯一约束并发错误，或（串行后）已签收错误——二者都证明只有一条记录
  assert.ok(outcomes.some((x) => x.startsWith('LOSE:')), `应有一个失败，实际 ${a}/${b}`);

  const verify = createApp(file);
  const n = verify.db.prepare(
    "SELECT COUNT(*) n FROM handoff_events WHERE registration_id='reg_小熊猫' AND stage_seq=3 AND result='SIGNED'"
  ).get().n;
  assert.equal(n, 1);
  verify.db.close();
});
