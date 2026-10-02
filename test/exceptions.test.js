'use strict';
// 六类异常应急路径：延误/改降/接机人更换/证件不一致/儿童不适/换班/联系不上家属。
const test = require('node:test');
const assert = require('node:assert');
const { seededApp, expectCode } = require('./helpers');

test('航班延误：登记异常并向送机/接机家属发短信', () => {
  const app = seededApp();
  app.flightAdapter._inject('CA1831', { status: 'DELAYED', depEstimate: '2026-10-02T12:00:00+08:00', reason: '流控' });
  app.service.pollFlightUpdate('reg_小海豚', 'SYSTEM');
  const ex = app.service.exceptionsOf('reg_小海豚');
  const delay = ex.find((e) => e.type === 'DELAY');
  assert.ok(delay);
  assert.ok(delay.actions.some((a) => a.kind === 'RESPONSE'), '延误必须带应急处置路径');
  const sms = app.service.smsLog('reg_小海豚').filter((m) => m.template === 'FLIGHT_DELAY');
  assert.equal(sms.length, 2, '送机人与接机人各收到一条');
});

test('改降：后续交接段与领取站切换，异常专区可见', () => {
  const app = seededApp(); // 种子内小熊猫已改降 SZX
  const tl = app.service.timeline('reg_小熊猫');
  assert.equal(tl[3].stationCode, 'SZX');
  assert.equal(tl[4].stationCode, 'SZX');
  assert.ok(app.service.exceptionsOf('reg_小熊猫').some((e) => e.type === 'DIVERT'));
});

test('接机人更换：异常留痕 + 授权版本递进 + 旧码失效', () => {
  const app = seededApp();
  app.service.changePickup({ regId: 'reg_小熊猫', staffId: 'stf_szx_st', newPersonId: 'psn_backup_szx', reason: '家属改约' });
  const change = app.service.exceptionsOf('reg_小熊猫').filter((e) => e.type === 'PICKUP_CHANGE');
  assert.ok(change.some((e) => e.detail.includes('立即失效')));
  const vers = app.db.prepare('SELECT version,status FROM pickup_authorizations WHERE registration_id=? ORDER BY version').all('reg_小熊猫');
  assert.equal(vers.at(-1).status, 'ACTIVE');
});

test('证件不一致：柜台核验失败不签发且登记异常', () => {
  const app = seededApp();
  expectCode(() => app.service.checkinIssue({
    regId: 'reg_小海豚', checkinStaffId: 'stf_pek_ci', groundStaffId: 'stf_pek_gr', escortIdNumber: 'FAKE123',
  }), 'ID_MISMATCH');
  assert.ok(app.service.exceptionsOf('reg_小海豚').some((e) => e.type === 'ID_MISMATCH'));
  // 未签发：地面段仍不能动
  expectCode(() => app.service.signStage({ regId: 'reg_小海豚', stageKey: 'GROUND_DEP', staffId: 'stf_pek_gr' }), 'OUT_OF_ORDER');
});

test('领取时现场证件不符：拒绝交付并保留待处置', () => {
  const app = seededApp();
  app.service.signStage({ regId: 'reg_小熊猫', stageKey: 'GROUND_ARR', staffId: 'stf_szx_gr' });
  expectCode(() => app.service.signStage({
    regId: 'reg_小熊猫', stageKey: 'PICKUP', staffId: 'stf_szx_st',
    toPersonId: 'psn_pickup_panda_v2', authCode: 'QW9XK5', pickupIdNumber: 'WRONG-NUMBER',
  }), 'ID_MISMATCH');
  assert.equal(app.db.prepare("SELECT status FROM registrations WHERE id='reg_小熊猫'").get().status, 'IN_CHAIN');
});

test('儿童身体不适：带标准应急处置路径', () => {
  const app = seededApp();
  const id = app.service.reportUnwell({ regId: 'reg_小海豚', staffId: 'stf_crew', symptom: '压耳疼痛、哭闹' });
  const ex = app.service.exceptionsOf('reg_小海豚').find((e) => e.id === id);
  assert.equal(ex.type, 'CHILD_UNWELL');
  assert.ok(ex.actions[0].text.includes('广播寻医'));
});

test('交接人临时换班：登记接班人，责任仍以本人签收为准', () => {
  const app = seededApp();
  const id = app.service.reportShiftChange({ regId: 'reg_小熊猫', staffId: 'stf_szx_gr', relieverStaffId: 'stf_hak_gr', stageKey: 'GROUND_ARR' });
  const ex = app.service.exceptionsOf('reg_小熊猫').find((e) => e.id === id);
  assert.ok(ex.detail.includes('吴到达'));
});

test('联系不上家属：启动备用联系人处置；闭环动作追加留痕', () => {
  const app = seededApp();
  const id = app.service.reportFamilyUnreachable({ regId: 'reg_小熊猫', staffId: 'stf_szx_st', attempts: '19:00/19:10/19:20 三次无人接' });
  app.service.respondException({ exceptionId: id, staffId: 'stf_szx_st', text: '已启用备用联系人王秀梅，儿童留在 SZX 受控接待区' });
  app.service.resolveException({ exceptionId: id, staffId: 'stf_szx_st', summary: '备用家属到场，正常领取' });
  const ex = app.service.exceptionsOf('reg_小熊猫').find((e) => e.id === id);
  // 标准应急处置 1 条 + 人工响应 1 条 + 闭环 1 条，均为追加动作
  assert.equal(ex.actions.length, 3);
  assert.equal(ex.actions.at(-1).kind, 'RESOLVE');
  assert.equal(ex.resolved, true);
});
