'use strict';
// 岗位最小可见 + 不可覆盖链（触发器/哈希）。
const test = require('node:test');
const assert = require('node:assert');
const { seededApp } = require('./helpers');

test('乘务组看不到送机人/接机人姓名、证件与电话', () => {
  const app = seededApp();
  const p = app.service.childProfileForRole('reg_小海豚', 'crew');
  assert.ok(!('escortName' in p), '乘务不可见送机人');
  assert.ok(!('pickupName' in p), '乘务不可见接机人');
  assert.ok(!('escortPhoneMasked' in p));
  assert.ok(!('pickupIdMasked' in p));
  // 但必须看到照顾说明
  assert.ok(p.specialCare.includes('花生'));
});

test('值机柜台可见送机人信息，仍看不到接机电话；到达站可见接机信息', () => {
  const app = seededApp();
  const ci = app.service.childProfileForRole('reg_小海豚', 'checkin');
  assert.equal(ci.escortName, '陈丽华');
  assert.ok(!('pickupPhoneMasked' in ci), '柜台不需要接机电话');
  assert.match(ci.escortIdMasked, /\*{8}/);

  const st = app.service.childProfileForRole('reg_小熊猫', 'station', { station_code: 'SZX' });
  assert.equal(st.pickupName, '王秀梅');
  assert.match(st.pickupPhoneMasked, /\*{4}/);
  assert.ok(!('escortName' in st), '到达站无需送机人身份信息');
});

test('任何岗位档案都不包含真实姓名令牌', () => {
  const app = seededApp();
  const token = app.db.prepare("SELECT real_name_token FROM children WHERE code_name='小海豚'").get().real_name_token;
  for (const role of ['checkin', 'ground', 'crew', 'station']) {
    const json = JSON.stringify(app.service.childProfileForRole('reg_小海豚', role, { station_code: 'PEK' }));
    assert.ok(!json.includes(token), `${role} 视角不得拿到真实姓名令牌`);
  }
});

test('遮罩工具：证件留头尾、电话中间四位打码', () => {
  const { maskId, maskPhone } = require('../src/util');
  assert.equal(maskId('110101199003154628'), '110********28');
  assert.equal(maskPhone('13800001111'), '138****1111');
});

test('交接链禁止 UPDATE 与 DELETE（不可覆盖）', () => {
  const app = seededApp();
  assert.throws(() => app.db.prepare("UPDATE handoff_events SET note='x' WHERE 1=1").run(), /不可覆盖/);
  assert.throws(() => app.db.prepare('DELETE FROM handoff_events WHERE 1=1').run(), /不可覆盖/);
});

test('异常表与短信表同样禁止事后改写', () => {
  const app = seededApp();
  assert.throws(() => app.db.prepare("UPDATE exception_events SET detail='x' WHERE 1=1").run(), /不可修改/);
  assert.throws(() => app.db.prepare("UPDATE sms_messages SET body='x' WHERE 1=1").run(), /不可修改/);
});

test('拒收记录同样串入哈希链（链头来源唯一、可逐环追溯）', () => {
  const app = seededApp();
  const s = app.service;
  s.checkinIssue({ regId: 'reg_小海豚', checkinStaffId: 'stf_pek_ci', groundStaffId: 'stf_pek_gr', escortIdNumber: '110101199003154628' });
  s.rejectStage({ regId: 'reg_小海豚', stageKey: 'GROUND_DEP', staffId: 'stf_pek_gr', reason: '退回复核' });
  const all = app.db.prepare("SELECT * FROM handoff_events WHERE registration_id=? ORDER BY created_at").all('reg_小海豚');
  for (let i = 1; i < all.length; i++) {
    assert.equal(all[i].prev_hash, all[i - 1].self_hash);
  }
});

test('异常处置只能追加（闭环通过新动作记录，而非修改原异常）', () => {
  const app = seededApp();
  const id = app.service.reportFamilyUnreachable({ regId: 'reg_小熊猫', staffId: 'stf_szx_st', attempts: '3 次无人接听' });
  app.service.resolveException({ exceptionId: id, staffId: 'stf_szx_st', summary: '已联系备用家属' });
  const ex = app.service.exceptionsOf('reg_小熊猫').find((e) => e.id === id);
  assert.equal(ex.resolved, true);
  assert.ok(ex.actions.some((a) => a.kind === 'RESOLVE'));
  // 原始异常行未被更新（append-only）：没有 resolved 列可改，闭环完全来自 actions
  assert.ok(!('resolved_at' in ex));
});

test('遮罩证件图为本地生成且不含完整证件号', () => {
  const app = seededApp();
  const doc = app.db.prepare("SELECT file_path FROM masked_docs WHERE registration_id='reg_小海豚' LIMIT 1").get();
  const svg = require('node:fs').readFileSync(doc.file_path, 'utf8');
  assert.ok(!svg.includes('110101199003154628'), '遮罩图中不得出现完整证件号');
  assert.ok(svg.includes('110********28'));
});
