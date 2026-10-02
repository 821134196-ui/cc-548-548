'use strict';
// 接机授权变更：新码生效、旧码立即失效；人码不一致拒绝；跨站经理不可变更。
const test = require('node:test');
const assert = require('node:assert');
const { seededApp, expectCode } = require('./helpers');

// 小熊猫已到 seq3 待 SZX 地面签收，授权 v1 REVOKED、v2 ACTIVE
function advanceToPickup(app) {
  app.service.signStage({ regId: 'reg_小熊猫', stageKey: 'GROUND_ARR', staffId: 'stf_szx_gr' });
}

test('旧授权码 v1 在领取时失效', () => {
  const app = seededApp();
  advanceToPickup(app);
  expectCode(() => app.service.signStage({
    regId: 'reg_小熊猫', stageKey: 'PICKUP', staffId: 'stf_szx_st',
    toPersonId: 'psn_pickup_panda_v1', authCode: 'LP4T8N', pickupIdNumber: '460100197502184426',
  }), 'AUTH_CODE_INVALID');
});

test('旧接机人持新码也不可领取（人码绑定）', () => {
  const app = seededApp();
  advanceToPickup(app);
  expectCode(() => app.service.signStage({
    regId: 'reg_小熊猫', stageKey: 'PICKUP', staffId: 'stf_szx_st',
    toPersonId: 'psn_pickup_panda_v1', authCode: 'QW9XK5', pickupIdNumber: '460100197502184426',
  }), 'PICKUP_PERSON_MISMATCH');
});

test('当前授权 v2 + 正确证件可领取，领取后授权置 USED', () => {
  const app = seededApp();
  advanceToPickup(app);
  app.service.signStage({
    regId: 'reg_小熊猫', stageKey: 'PICKUP', staffId: 'stf_szx_st',
    toPersonId: 'psn_pickup_panda_v2', authCode: 'QW9XK5', pickupIdNumber: '44030019810809752X',
  });
  const rows = app.db.prepare('SELECT version,status FROM pickup_authorizations WHERE registration_id=? ORDER BY version').all('reg_小熊猫');
  assert.deepEqual(rows.map((r) => r.status), ['REVOKED', 'USED']);
});

test('运行中发起授权变更：旧版本同事务 REVOKED，新版本 ACTIVE，旧码立即不可用', () => {
  const app = seededApp();
  // 小海豚当前 v1 ACTIVE（KD7MQ2）；由 PVG 站经理变更为备用接机人
  const r = app.service.changePickup({
    regId: 'reg_小海豚', staffId: 'stf_pvg_st', newPersonId: 'psn_backup_pvg',
    reason: '测试变更',
  });
  const v1 = app.db.prepare("SELECT status FROM pickup_authorizations WHERE registration_id='reg_小海豚' AND version=1").get();
  const v2 = app.db.prepare("SELECT status,person_id FROM pickup_authorizations WHERE registration_id='reg_小海豚' AND version=2").get();
  assert.equal(v1.status, 'REVOKED');
  assert.equal(v2.status, 'ACTIVE');
  assert.equal(v2.person_id, 'psn_backup_pvg');

  // 走完链后，旧码领取失败、新码领取成功
  const s = app.service;
  s.checkinIssue({ regId: 'reg_小海豚', checkinStaffId: 'stf_pek_ci', groundStaffId: 'stf_pek_gr', escortIdNumber: '110101199003154628' });
  s.signStage({ regId: 'reg_小海豚', stageKey: 'GROUND_DEP', staffId: 'stf_pek_gr' });
  s.signStage({ regId: 'reg_小海豚', stageKey: 'CREW', staffId: 'stf_crew' });
  s.signStage({ regId: 'reg_小海豚', stageKey: 'GROUND_ARR', staffId: 'stf_pvg_gr' });
  expectCode(() => s.signStage({ regId: 'reg_小海豚', stageKey: 'PICKUP', staffId: 'stf_pvg_st',
    toPersonId: 'psn_pickup_dolphin', authCode: 'KD7MQ2', pickupIdNumber: '310104198507223311' }), 'AUTH_CODE_INVALID');
  s.signStage({ regId: 'reg_小海豚', stageKey: 'PICKUP', staffId: 'stf_pvg_st',
    toPersonId: 'psn_backup_pvg', authCode: r.code, pickupIdNumber: '310115199201206642' });
  assert.equal(app.db.prepare("SELECT status FROM registrations WHERE id='reg_小海豚'").get().status, 'COMPLETED');
});

test('授权变更发短信：新接机人收新码，旧接机人收失效通知', () => {
  const app = seededApp();
  app.service.changePickup({ regId: 'reg_小熊猫', staffId: 'stf_szx_st', newPersonId: 'psn_backup_szx', reason: '再变更' });
  const sms = app.service.smsLog('reg_小熊猫').map((m) => m.template);
  assert.ok(sms.includes('PICKUP_AUTH_NEW'));
  assert.ok(sms.includes('PICKUP_AUTH_REVOKED'));
});

test('非到达站/柜台岗位无权发起授权变更', () => {
  const app = seededApp();
  expectCode(() => app.service.changePickup({
    regId: 'reg_小熊猫', staffId: 'stf_crew', newPersonId: 'psn_backup_szx',
  }), 'ROLE_DENIED');
});

test('跨站接待员（HAK）不得在改降站 SZX 发起授权变更', () => {
  const app = seededApp();
  // stf_hak 只有地面，给一名 HAK station 测试：复用 seed 无 HAK station，直接插入
  app.db.prepare("INSERT INTO staff(id,name,role,station_code,active,created_at) VALUES('stf_hak_st','郝接待','station','HAK',1,'t')").run();
  expectCode(() => app.service.changePickup({
    regId: 'reg_小熊猫', staffId: 'stf_hak_st', newPersonId: 'psn_backup_szx',
  }), 'STATION_DENIED');
});
