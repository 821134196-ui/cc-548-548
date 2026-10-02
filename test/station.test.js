'use strict';
// 跨站权限：地面/柜台/接待按站隔离；改降后后续段自动切换至改降站；乘务随机不受站点限制。
const test = require('node:test');
const assert = require('node:assert');
const { seededApp, expectCode } = require('./helpers');

test('出发站地面不能由别的站账号签收', () => {
  const app = seededApp();
  const s = app.service;
  s.checkinIssue({ regId: 'reg_小海豚', checkinStaffId: 'stf_pek_ci', groundStaffId: 'stf_pek_gr', escortIdNumber: '110101199003154628' });
  expectCode(() => s.signStage({ regId: 'reg_小海豚', stageKey: 'GROUND_DEP', staffId: 'stf_pvg_gr' }), 'STATION_DENIED');
  // 岗位正确但非指定接收人
  expectCode(() => s.signStage({ regId: 'reg_小海豚', stageKey: 'GROUND_DEP', staffId: 'stf_pek_gr2' }), 'PARTY_MISMATCH');
});

test('改降后：原目的站 HAK 地面不能签收，改降站 SZX 地面可以', () => {
  const app = seededApp();
  // 小熊猫已在 S/C/G 三段之后，改降 SZX
  expectCode(() => app.service.signStage({ regId: 'reg_小熊猫', stageKey: 'GROUND_ARR', staffId: 'stf_hak_gr' }), 'STATION_DENIED');
  app.service.signStage({ regId: 'reg_小熊猫', stageKey: 'GROUND_ARR', staffId: 'stf_szx_gr' });
  const tl = app.service.timeline('reg_小熊猫');
  assert.equal(tl[3].stationCode, 'SZX');
  assert.equal(tl[3].signed, true);
});

test('改降后领取段监交人必须是 SZX 站接待', () => {
  const app = seededApp();
  app.service.signStage({ regId: 'reg_小熊猫', stageKey: 'GROUND_ARR', staffId: 'stf_szx_gr' });
  app.db.prepare("INSERT INTO staff(id,name,role,station_code,active,created_at) VALUES('stf_hak_st','郝接待','station','HAK',1,'t')").run();
  expectCode(() => app.service.signStage({
    regId: 'reg_小熊猫', stageKey: 'PICKUP', staffId: 'stf_hak_st',
    toPersonId: 'psn_pickup_panda_v2', authCode: 'QW9XK5', pickupIdNumber: '44030019810809752X',
  }), 'STATION_DENIED');
});

test('乘务组随机，不做站点限制，可在任意航段客舱签收', () => {
  const app = seededApp();
  const s = app.service;
  s.checkinIssue({ regId: 'reg_小海豚', checkinStaffId: 'stf_pek_ci', groundStaffId: 'stf_pek_gr', escortIdNumber: '110101199003154628' });
  s.signStage({ regId: 'reg_小海豚', stageKey: 'GROUND_DEP', staffId: 'stf_pek_gr' });
  // 乘务长 station_code 为机队码 CA-CABIN，仍可签收
  s.signStage({ regId: 'reg_小海豚', stageKey: 'CREW', staffId: 'stf_crew' });
  assert.ok(true);
});

test('岗位不符：地面账号不能执行柜台签发', () => {
  const app = seededApp();
  expectCode(() => app.service.checkinIssue({
    regId: 'reg_小海豚', checkinStaffId: 'stf_pek_gr', groundStaffId: 'stf_pek_gr', escortIdNumber: '110101199003154628',
  }), 'ROLE_DENIED');
});

test('改降动态由模拟适配器推送后轮询生效，并通知家属', () => {
  const app = seededApp();
  app.flightAdapter._inject('CA1831', { status: 'DIVERTED', divertedTo: 'HGH', reason: 'PVG 天气' });
  const f = app.service.pollFlightUpdate('reg_小海豚', 'SYSTEM');
  assert.equal(f.status, 'DIVERTED');
  assert.equal(f.diverted_to, 'HGH');
  const types = app.service.exceptionsOf('reg_小海豚').map((e) => e.type);
  assert.ok(types.includes('DIVERT'));
  // 后续两段站点切到 HGH（即使本地没有 HAK staff，时间线也应反映）
  assert.equal(app.service.timeline('reg_小海豚')[3].stationCode, 'HGH');
});

test('同一条动态重复轮询不产生重复异常（幂等）', () => {
  const app = seededApp();
  app.flightAdapter._inject('CA1831', { status: 'DELAYED', depEstimate: '2026-10-02T12:00:00+08:00' });
  app.service.pollFlightUpdate('reg_小海豚', 'SYSTEM');
  app.service.pollFlightUpdate('reg_小海豚', 'SYSTEM');
  const n = app.service.exceptionsOf('reg_小海豚').filter((e) => e.type === 'DELAY').length;
  assert.equal(n, 1);
});
