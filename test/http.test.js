'use strict';
// HTTP 集成：页面可达、动作以当前视角执行并被规则拦截、遮罩图只出登记文件。
const test = require('node:test');
const assert = require('node:assert');
const { createServer } = require('../src/server');
const { seededApp } = require('./helpers');

function startServer() {
  const app = seededApp();
  const server = createServer(app);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ base: `http://127.0.0.1:${port}`, app, close: () => server.close() });
    });
  });
}

async function postForm(base, action, params) {
  const body = new URLSearchParams(params).toString();
  const res = await fetch(base + action, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body, redirect: 'manual',
  });
  return { status: res.status, location: res.headers.get('location') || '' };
}
const qs = (s) => encodeURIComponent(s);

test('首页与交接页 200，大字要素齐全', async () => {
  const { base, close } = await startServer();
  try {
    const home = await (await fetch(base + '/')).text();
    assert.ok(home.includes('小海豚') && home.includes('小熊猫'));

    const page = await (await fetch(base + `/case?reg=${qs('reg_小熊猫')}&staff=stf_szx_st`)).text();
    for (const needle of ['儿童代号：小熊猫', '下一责任人：到达站地面接收', 'SZX', '异常路径专区', '旧码立即失效', '航段时间线']) {
      assert.ok(page.includes(needle), `页面缺少：${needle}`);
    }
  } finally { close(); }
});

test('HTTP 顺序流：柜台→地面→乘务→到达→领取，错误操作被 303 回错误信息', async () => {
  const { base, app, close } = await startServer();
  try {
    const back = '/case?reg=' + qs('reg_小海豚');
    let r = await postForm(base, '/checkin', { reg: 'reg_小海豚', staff: 'stf_pek_ci', groundStaffId: 'stf_pek_gr', escortIdNumber: 'BAD' });
    assert.match(decodeURIComponent(r.location), /ID_MISMATCH/);

    r = await postForm(base, '/checkin', { reg: 'reg_小海豚', staff: 'stf_pek_ci', groundStaffId: 'stf_pek_gr', escortIdNumber: '110101199003154628' });
    assert.match(decodeURIComponent(r.location), /ok=/);

    r = await postForm(base, '/sign', { reg: 'reg_小海豚', staff: 'stf_pvg_gr', stage: 'GROUND_DEP' });
    assert.match(decodeURIComponent(r.location), /STATION_DENIED/);

    for (const [staff, stage] of [['stf_pek_gr', 'GROUND_DEP'], ['stf_crew', 'CREW'], ['stf_pvg_gr', 'GROUND_ARR']]) {
      r = await postForm(base, '/sign', { reg: 'reg_小海豚', staff, stage });
      assert.match(decodeURIComponent(r.location), /ok=/, `${stage} 应成功`);
    }
    r = await postForm(base, '/pickup', { reg: 'reg_小海豚', staff: 'stf_pvg_st', toPersonId: 'psn_pickup_dolphin', authCode: 'WRONG1', pickupIdNumber: '310104198507223311' });
    assert.match(decodeURIComponent(r.location), /AUTH_CODE_INVALID/);

    r = await postForm(base, '/pickup', { reg: 'reg_小海豚', staff: 'stf_pvg_st', toPersonId: 'psn_pickup_dolphin', authCode: 'KD7MQ2', pickupIdNumber: '310104198507223311' });
    assert.match(decodeURIComponent(r.location), /闭环/);
    assert.equal(app.db.prepare("SELECT status FROM registrations WHERE id='reg_小海豚'").get().status, 'COMPLETED');
  } finally { close(); }
});

test('HTTP 授权变更后旧码领取失败', async () => {
  const { base, close } = await startServer();
  try {
    let r = await postForm(base, '/change-pickup', { reg: 'reg_小海豚', staff: 'stf_pvg_st', newPersonId: 'psn_backup_pvg', reason: '网页演练变更' });
    assert.equal(r.status, 303);
    // 推进链
    await postForm(base, '/checkin', { reg: 'reg_小海豚', staff: 'stf_pek_ci', groundStaffId: 'stf_pek_gr', escortIdNumber: '110101199003154628' });
    await postForm(base, '/sign', { reg: 'reg_小海豚', staff: 'stf_pek_gr', stage: 'GROUND_DEP' });
    await postForm(base, '/sign', { reg: 'reg_小海豚', staff: 'stf_crew', stage: 'CREW' });
    await postForm(base, '/sign', { reg: 'reg_小海豚', staff: 'stf_pvg_gr', stage: 'GROUND_ARR' });
    r = await postForm(base, '/pickup', { reg: 'reg_小海豚', staff: 'stf_pvg_st', toPersonId: 'psn_pickup_dolphin', authCode: 'KD7MQ2', pickupIdNumber: '310104198507223311' });
    assert.match(decodeURIComponent(r.location), /AUTH_CODE_INVALID/);
  } finally { close(); }
});

test('HTTP 模拟延误推送后页面出现异常与短信', async () => {
  const { base, close } = await startServer();
  try {
    const r = await postForm(base, '/sim-delay', { reg: 'reg_小海豚', staff: 'stf_pek_ci' });
    assert.equal(r.status, 303);
    const page = await (await fetch(base + `/case?reg=${qs('reg_小海豚')}&staff=stf_pek_ci`)).text();
    assert.ok(page.includes('航班延误'));
    assert.ok(page.includes('FLIGHT_DELAY'));
  } finally { close(); }
});

test('遮罩证件端点：未登记 id 返回 404', async () => {
  const { base, app, close } = await startServer();
  try {
    const docId = app.db.prepare("SELECT id FROM masked_docs WHERE registration_id='reg_小海豚' LIMIT 1").get().id;
    const ok = await fetch(base + '/doc/' + docId);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('content-type'), 'image/svg+xml; charset=utf-8');
    const missing = await fetch(base + '/doc/ev_nope');
    assert.equal(missing.status, 404);
  } finally { close(); }
});
