'use strict';
// 签收顺序：上一环节未签收不得跳过；正常链必须逐段推进；哈希链首尾相接。
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { seededApp, expectCode } = require('./helpers');

function sign(s, staffId, stageKey, extra = {}) {
  return s.signStage({ regId: 'reg_小海豚', stageKey, staffId, ...extra });
}

test('未签发时任何后续段都不可签收（不得跳段）', () => {
  const app = seededApp();
  return expectCode(() => sign(app.service, 'stf_crew', 'CREW'), 'OUT_OF_ORDER');
});

test('只能从柜台签发开始，且须先核验送机人', () => {
  const app = seededApp();
  expectCode(() => sign(app.service, 'stf_pek_ci', 'CHECKIN', { groundStaffId: 'stf_pek_gr' }), 'ESCORT_NOT_VERIFIED');
});

test('正常链路按 柜台→地面→乘务→到达地面→接机 顺序逐段签收', () => {
  const app = seededApp();
  const s = app.service;
  s.checkinIssue({ regId: 'reg_小海豚', checkinStaffId: 'stf_pek_ci', groundStaffId: 'stf_pek_gr', escortIdNumber: '110101199003154628' });
  sign(s, 'stf_pek_gr', 'GROUND_DEP');
  // 地面未交给乘务前，到达站不能抢
  expectCode(() => sign(s, 'stf_pvg_gr', 'GROUND_ARR'), 'OUT_OF_ORDER');
  sign(s, 'stf_crew', 'CREW');
  sign(s, 'stf_pvg_gr', 'GROUND_ARR');
  sign(s, 'stf_pvg_st', 'PICKUP', { toPersonId: 'psn_pickup_dolphin', authCode: 'KD7MQ2', pickupIdNumber: '310104198507223311' });

  const tl = s.timeline('reg_小海豚');
  assert.deepEqual(tl.map((x) => x.signed), [true, true, true, true, true]);
  assert.equal(app.db.prepare("SELECT status FROM registrations WHERE id='reg_小海豚'").get().status, 'COMPLETED');
});

test('每段 prev_hash 与上一事件 self_hash 首尾相接，且自哈希可重算', () => {
  const app = seededApp();
  const s = app.service;
  s.checkinIssue({ regId: 'reg_小海豚', checkinStaffId: 'stf_pek_ci', groundStaffId: 'stf_pek_gr', escortIdNumber: '110101199003154628' });
  sign(s, 'stf_pek_gr', 'GROUND_DEP');
  sign(s, 'stf_crew', 'CREW');

  const events = app.db.prepare("SELECT * FROM handoff_events WHERE registration_id=? ORDER BY stage_seq").all('reg_小海豚');
  let expectedPrev = null;
  for (const e of events) {
    assert.equal(e.prev_hash, expectedPrev, `段 ${e.stage_seq} 的 prev_hash 未与上段衔接`);
    // 按服务端公式重算自哈希（签收人：seq0=from，seq1..3=to，seq4=监交 agent）
    const signer = e.stage_seq === 0 ? e.from_staff_id
      : e.stage_seq === 4 ? e.agent_staff_id : e.to_staff_id;
    const payload = [e.registration_id, e.stage_seq, e.stage_key,
      e.from_staff_id || '', signer, e.to_person_id || '', e.auth_version ?? '',
      e.created_at, e.note || ''].join('|');
    const calc = crypto.createHash('sha256').update(`${e.prev_hash || 'GENESIS'}|${payload}`).digest('hex');
    assert.equal(calc, e.self_hash, `段 ${e.stage_seq} 自哈希不匹配`);
    expectedPrev = e.self_hash;
  }
});

test('REJECTED 不推进链，后续段仍被拦截', () => {
  const app = seededApp();
  const s = app.service;
  s.checkinIssue({ regId: 'reg_小海豚', checkinStaffId: 'stf_pek_ci', groundStaffId: 'stf_pek_gr', escortIdNumber: '110101199003154628' });
  s.rejectStage({ regId: 'reg_小海豚', stageKey: 'GROUND_DEP', staffId: 'stf_pek_gr', reason: '儿童背包名牌松动，退回柜台复核' });
  expectCode(() => sign(s, 'stf_crew', 'CREW'), 'OUT_OF_ORDER');
  // 复核后仍可由指定地面人员正常签收
  sign(s, 'stf_pek_gr', 'GROUND_DEP');
  sign(s, 'stf_crew', 'CREW');
  assert.ok(true);
});
