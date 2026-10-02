'use strict';
// 种子数据：纯虚构人员/航班。
//  样例一  小海豚 CA1831 PEK→PVG：全新登记，等待柜台核验签发（供完整演示）。
//  样例二  小熊猫 MU5318 CAN→HAK：已完成柜台/地面/乘务三段，途中改降 SZX，
//          且接机授权已从 v1 更换为 v2（旧码失效）——即题目要求的"改降样例"。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { nowIso, genId } = require('./util');
const { hashAuthCode } = require('./service');
const { writeMaskedDoc } = require('./docs');

function ins(db, table, row) {
  const cols = Object.keys(row);
  db.prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
    .run(...cols.map((c) => row[c]));
}

function seedApp(app, { docsDir = path.join(__dirname, '..', 'data', 'docs') } = {}) {
  const { db, service, flightAdapter } = app;
  const have = db.prepare('SELECT COUNT(*) n FROM staff').get().n;
  if (have) return catalog(app); // 幂等：已有数据不重复播种

  const t = nowIso();

  // ---------- 工作人员 ----------
  const staff = [
    ['stf_pek_ci', '王值机', 'checkin', 'PEK'],
    ['stf_pek_gr', '李地勤', 'ground', 'PEK'],
    ['stf_pek_gr2', '赵地勤', 'ground', 'PEK'],
    ['stf_pvg_gr', '孙到达', 'ground', 'PVG'],
    ['stf_pvg_st', '钱接待', 'station', 'PVG'],
    ['stf_can_ci', '冯值机', 'checkin', 'CAN'],
    ['stf_can_gr', '陈地勤', 'ground', 'CAN'],
    ['stf_szx_gr', '褚到达', 'ground', 'SZX'],
    ['stf_szx_st', '卫经理', 'station', 'SZX'],
    ['stf_hak_gr', '吴到达', 'ground', 'HAK'],
    ['stf_crew', '周乘务长', 'crew', 'CA-CABIN'],
  ];
  for (const [id, name, role, station] of staff) {
    ins(db, 'staff', { id, name, role, station_code: station, shift_no: 'D', active: 1, created_at: t });
  }

  // ---------- 虚构家属 ----------
  const persons = [
    ['psn_escort_dolphin', '陈丽华', '110101199003154628', '13800001111'],
    ['psn_pickup_dolphin', '陈国华', '310104198507223311', '13900002222'],
    ['psn_escort_panda', '张建国', '440103197911056217', '13700003333'],
    ['psn_pickup_panda_v1', '李桂兰', '460100197502184426', '13600004444'],
    ['psn_pickup_panda_v2', '王秀梅', '44030019810809752X', '13500005555'],
    ['psn_backup_pvg', '周婷（备用接机人）', '310115199201206642', '13400006666'],
    ['psn_backup_szx', '刘敏（备用接机人）', '440304198805271183', '13300007777'],
  ];
  for (const [id, name, idn, phone] of persons) {
    ins(db, 'persons', { id, name, id_number: idn, phone, created_at: t });
  }

  function issueAuth(regId, version, personId, code, revoked = false) {
    ins(db, 'pickup_authorizations', {
      id: genId('auth'), registration_id: regId, version, person_id: personId,
      auth_code_hash: hashAuthCode(code),
      auth_code_hint: `${code.slice(0, 2)}***${code.slice(-1)}`,
      status: revoked ? 'REVOKED' : 'ACTIVE',
      issued_at: t, revoked_at: revoked ? t : null,
      revoke_reason: revoked ? '航班改降，家属申请更换接机人' : null,
    });
  }

  function register({ childId, codeName, realToken, ageBand, care, med, flightNo, seat,
    fromCode, toCode, dep, arr, escortId, formNo }) {
    ins(db, 'children', {
      id: childId, code_name: codeName, real_name_token: realToken,
      age_band: ageBand, special_care: care, med_notes: med, created_at: t,
    });
    const flightId = `flt_${codeName}`;
    ins(db, 'flights', {
      id: flightId, child_id: childId, flight_no: flightNo, seat,
      from_code: fromCode, to_code: toCode, sched_dep: dep, sched_arr: arr,
      status: 'SCHEDULED', diverted_to: null, created_at: t,
    });
    const regId = `reg_${codeName}`;
    ins(db, 'registrations', {
      id: regId, child_id: childId, flight_id: flightId, escort_id: escortId,
      handoff_form_no: formNo, status: 'OPEN', created_at: t,
    });
    return { regId, flightId };
  }

  function doc(regId, personId, kind, name, idn, seat, flightNo) {
    const fp = writeMaskedDoc(docsDir, { kind, name, idNumber: idn, seat, flightNo });
    ins(db, 'masked_docs', {
      id: genId('mdc'), registration_id: regId, person_id: personId,
      doc_kind: kind, file_path: fp, created_at: t,
    });
  }

  // ===== 样例一：小海豚（全新，待柜台签发）=====
  const dolphin = register({
    childId: 'chi_dolphin', codeName: '小海豚', realToken: 'RTOK-' + crypto.randomBytes(4).toString('hex'),
    ageBand: '7 岁', care: '对花生过敏；喜欢靠窗；抵达前需提醒上洗手间。',
    med: '随身背包内有过敏药，勿托运。',
    flightNo: 'CA1831', seat: '18A', fromCode: 'PEK', toCode: 'PVG',
    dep: '2026-10-02T09:00:00+08:00', arr: '2026-10-02T11:25:00+08:00',
    escortId: 'psn_escort_dolphin', formNo: 'UMNR-PEK-20261002-018',
  });
  issueAuth(dolphin.regId, 1, 'psn_pickup_dolphin', 'KD7MQ2');

  doc(dolphin.regId, 'psn_escort_dolphin', 'ESCORT_ID', '陈丽华', '110101199003154628', '18A', 'CA1831');
  doc(dolphin.regId, 'psn_pickup_dolphin', 'PICKUP_ID', '陈国华', '310104198507223311', '18A', 'CA1831');

  // ===== 样例二：小熊猫（改降 SZX + 授权变更）=====
  const panda = register({
    childId: 'chi_panda', codeName: '小熊猫', realToken: 'RTOK-' + crypto.randomBytes(4).toString('hex'),
    ageBand: '10 岁', care: '轻微晕机，每 40 分钟提醒喝水；无人陪伴经验第二次。',
    med: '无慢性病，备有晕机贴。',
    flightNo: 'MU5318', seat: '22C', fromCode: 'CAN', toCode: 'HAK',
    dep: '2026-10-02T07:40:00+08:00', arr: '2026-10-02T09:05:00+08:00',
    escortId: 'psn_escort_panda', formNo: 'UMNR-CAN-20261002-007',
  });
  // 原始授权 v1（随后将被服务端撤销）
  issueAuth(panda.regId, 1, 'psn_pickup_panda_v1', 'LP4T8N');

  doc(panda.regId, "psn_escort_panda", "ESCORT_ID", "张建国", "440103197911056217", "22C", "MU5318");
  doc(panda.regId, "psn_pickup_panda_v1", "PICKUP_ID", "李桂兰（v1已撤销）", "460100197502184426", "22C", "MU5318");
  doc(panda.regId, "psn_pickup_panda_v2", "PICKUP_ID", "王秀梅（v2）", "44030019810809752X", "22C", "MU5318");

  // 走完前三段：柜台 -> 地面 -> 乘务
  service.checkinIssue({
    regId: panda.regId, checkinStaffId: 'stf_can_ci', groundStaffId: 'stf_can_gr',
    escortIdNumber: '440103197911056217',
  });
  service.signStage({ regId: panda.regId, stageKey: 'GROUND_DEP', staffId: 'stf_can_gr' });
  service.signStage({ regId: panda.regId, stageKey: 'CREW', staffId: 'stf_crew', note: '滑行前已确认儿童安全带与呼吸状态正常' });

  // 飞行中：模拟适配器给出改降动态，轮询后落地异常 + 通知
  flightAdapter._inject('MU5318', {
    status: 'DIVERTED', divertedTo: 'SZX',
    arrEstimate: '2026-10-02T09:40:00+08:00', reason: '海口雷雨',
  });
  service.pollFlightUpdate(panda.regId, 'stf_crew');

  // 改降引发接机人更换：SZX 站值班经理发起，旧码 v1 同事务失效，新码 v2 下发
  service.changePickup({
    regId: panda.regId, staffId: 'stf_szx_st', newPersonId: 'psn_pickup_panda_v2',
    reason: '航班改降 SZX，海口接机人无法跨市，家属申请更换', code: 'QW9XK5',
  });

  return catalog(app);
}

function catalog(app) {
  const rows = app.db.prepare('SELECT id, code_name FROM children ORDER BY created_at').all();
  const out = {};
  for (const r of rows) {
    const reg = app.db.prepare('SELECT id FROM registrations WHERE child_id=?').get(r.id);
    out[r.code_name] = { childId: r.id, regId: reg.id };
  }
  return out;
}

// CLI：node src/seed.js [--reset]
if (require.main === module) {
  const dataFile = path.join(__dirname, '..', 'data', 'umnr.sqlite');
  if (process.argv.includes('--reset') && fs.existsSync(dataFile)) {
    for (const f of [dataFile, dataFile + '-wal', dataFile + '-shm']) {
      try { fs.rmSync(f); } catch { /* ignore */ }
    }
  }
  const { createApp } = require('./app');
  const app = createApp(dataFile, {
    MU5318: { status: 'DIVERTED', divertedTo: 'SZX', reason: '海口雷雨' },
  });
  const cat = seedApp(app);
  console.log('种子完成：', JSON.stringify(cat, null, 2));
}

module.exports = { seedApp, catalog };
