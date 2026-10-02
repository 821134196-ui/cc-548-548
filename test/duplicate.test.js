'use strict';
// 重复签收：同段二次签收被拒；REJECTED 不占用有效记录。
const test = require('node:test');
const assert = require('node:assert');
const { seededApp, expectCode } = require('./helpers');

test('同一段重复签收被拒（应用层）', () => {
  const app = seededApp();
  const s = app.service;
  s.checkinIssue({ regId: 'reg_小海豚', checkinStaffId: 'stf_pek_ci', groundStaffId: 'stf_pek_gr', escortIdNumber: '110101199003154628' });
  s.signStage({ regId: 'reg_小海豚', stageKey: 'GROUND_DEP', staffId: 'stf_pek_gr' });
  expectCode(() => s.signStage({ regId: 'reg_小海豚', stageKey: 'GROUND_DEP', staffId: 'stf_pek_gr' }), 'ALREADY_SIGNED');
});

test('两名工作人员同时交接：只有一条 SIGNED（唯一索引兜底）', () => {
  const app = seededApp();
  const s = app.service;
  s.checkinIssue({ regId: 'reg_小海豚', checkinStaffId: 'stf_pek_ci', groundStaffId: 'stf_pek_gr', escortIdNumber: '110101199003154628' });
  s.signStage({ regId: 'reg_小海豚', stageKey: 'GROUND_DEP', staffId: 'stf_pek_gr' });

  // 旁路 INSERT：模拟并发中"晚到一步"的第二名工作人员落库
  const ev = app.db.prepare("SELECT * FROM handoff_events WHERE registration_id=? AND stage_seq=1 AND result='SIGNED'").get('reg_小海豚');
  let blocked = false;
  try {
    app.db.prepare(`INSERT INTO handoff_events
      (id, registration_id, stage_seq, stage_key, flight_id, station_code,
       from_staff_id, to_staff_id, agent_staff_id, result, created_at, prev_hash, self_hash)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run('ev_dup_2', ev.registration_id, 1, 'GROUND_DEP', ev.flight_id, 'PEK',
        ev.from_staff_id, 'stf_pek_gr', 'stf_pek_gr', 'SIGNED',
        new Date().toISOString(), ev.prev_hash, 'forged-hash');
  } catch (e) { blocked = /UNIQUE/i.test(e.message); }
  assert.ok(blocked, '部分唯一索引必须拒绝同段第二条 SIGNED');

  const signedCount = app.db.prepare(
    "SELECT COUNT(*) n FROM handoff_events WHERE registration_id=? AND stage_seq=1 AND result='SIGNED'"
  ).get('reg_小海豚').n;
  assert.equal(signedCount, 1, '同段只允许一条有效签收');
});

test('多条 REJECTED 允许并存，但不影响唯一 SIGNED', () => {
  const app = seededApp();
  const s = app.service;
  s.checkinIssue({ regId: 'reg_小海豚', checkinStaffId: 'stf_pek_ci', groundStaffId: 'stf_pek_gr', escortIdNumber: '110101199003154628' });
  s.rejectStage({ regId: 'reg_小海豚', stageKey: 'GROUND_DEP', staffId: 'stf_pek_gr', reason: '退回一' });
  s.rejectStage({ regId: 'reg_小海豚', stageKey: 'GROUND_DEP', staffId: 'stf_pek_gr', reason: '退回二' });
  s.signStage({ regId: 'reg_小海豚', stageKey: 'GROUND_DEP', staffId: 'stf_pek_gr' });
  const row = app.db.prepare(
    "SELECT SUM(result='REJECTED') rj, SUM(result='SIGNED') sg FROM handoff_events WHERE registration_id=? AND stage_seq=1"
  ).get('reg_小海豚');
  assert.equal(row.rj, 2);
  assert.equal(row.sg, 1);
});

test('闭环后任何补签都被拒', () => {
  const app = seededApp();
  const s = app.service;
  s.checkinIssue({ regId: 'reg_小海豚', checkinStaffId: 'stf_pek_ci', groundStaffId: 'stf_pek_gr', escortIdNumber: '110101199003154628' });
  s.signStage({ regId: 'reg_小海豚', stageKey: 'GROUND_DEP', staffId: 'stf_pek_gr' });
  s.signStage({ regId: 'reg_小海豚', stageKey: 'CREW', staffId: 'stf_crew' });
  s.signStage({ regId: 'reg_小海豚', stageKey: 'GROUND_ARR', staffId: 'stf_pvg_gr' });
  s.signStage({ regId: 'reg_小海豚', stageKey: 'PICKUP', staffId: 'stf_pvg_st',
    toPersonId: 'psn_pickup_dolphin', authCode: 'KD7MQ2', pickupIdNumber: '310104198507223311' });
  expectCode(() => s.signStage({ regId: 'reg_小海豚', stageKey: 'PICKUP', staffId: 'stf_pvg_st',
    toPersonId: 'psn_pickup_dolphin', authCode: 'KD7MQ2', pickupIdNumber: '310104198507223311' }), 'ALREADY_SIGNED');
});
