'use strict';
// 领域服务：交接链全部业务规则。
// 规则要点：
//  1) 顺序：上一段未 SIGNED 不得签收下一段（stage_seq 必须连续，且前置段已签收）。
//  2) 重复签收：同段二次签收被拒绝（应用层 + DB 部分唯一索引双保险）。
//  3) 两名工作人员同时交接：事务 + 唯一索引保证只有一条 SIGNED。
//  4) 授权变更：新版本 ACTIVE 时旧版本立即 REVOKED，旧码在领取时失效。
//  5) 跨站：地面/到达站操作人 station 必须与段发生站一致（改降后以实际到达站为准）。
//  6) 岗位最小可见：档案按角色返回字段，真名令牌不对任何岗位下发。
const crypto = require('node:crypto');
const {
  STAGES, STAGE_KEYS, nowIso, genId, genAuthCode,
  maskId, maskPhone, FIELD_VISIBILITY, SELF_PICKUP_EXTRA,
} = require('./util');

class DomainError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function hashAuthCode(code) {
  return crypto.createHash('sha256').update(`umnr:${code}`).digest('hex');
}
function codeHint(code) { return `${code.slice(0, 2)}***${code.slice(-1)}`; }
function hashEvent(payload, prevHash) {
  return crypto.createHash('sha256').update(`${prevHash || 'GENESIS'}|${payload}`).digest('hex');
}

function createService(db, { flightAdapter, smsAdapter }) {
  // node:sqlite 事务助手
  function tx(fn) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      db.exec('COMMIT');
      return out;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
  const q = {
    staff: db.prepare('SELECT * FROM staff WHERE id=?'),
    reg: db.prepare('SELECT * FROM registrations WHERE id=?'),
    flight: db.prepare('SELECT * FROM flights WHERE id=?'),
    child: db.prepare('SELECT * FROM children WHERE id=?'),
    person: db.prepare('SELECT * FROM persons WHERE id=?'),
    events: db.prepare('SELECT * FROM handoff_events WHERE registration_id=? ORDER BY stage_seq, created_at'),
    signedAtStage: db.prepare("SELECT * FROM handoff_events WHERE registration_id=? AND stage_seq=? AND result='SIGNED'"),
    activeAuth: db.prepare("SELECT * FROM pickup_authorizations WHERE registration_id=? AND status='ACTIVE' ORDER BY version DESC LIMIT 1"),
    authByVersion: db.prepare('SELECT * FROM pickup_authorizations WHERE registration_id=? AND version=?'),
  };

  function mustStaff(staffId) {
    const s = q.staff.get(staffId);
    if (!s || !s.active) throw new DomainError('STAFF_INVALID', '工作人员不存在或已停用');
    return s;
  }
  function mustReg(regId) {
    const r = q.reg.get(regId);
    if (!r) throw new DomainError('REG_NOT_FOUND', '登记不存在');
    return r;
  }

  // ---------- 查询：航段时间线 ----------
  function timeline(regId) {
    const reg = mustReg(regId);
    const flight = q.flight.get(reg.flight_id);
    const events = q.events.all(regId);
    const signedBySeq = new Map(events.filter((e) => e.result === 'SIGNED').map((e) => [e.stage_seq, e]));
    const live = flightAdapter.getStatus(flight);
    const actualTo = flight.status === 'DIVERTED' && flight.diverted_to ? flight.diverted_to : flight.to_code;
    return STAGES.map((stage, seq) => {
      const ev = signedBySeq.get(seq);
      const stationCode = seq <= 2 ? flight.from_code : actualTo;
      return {
        seq, key: stage.key, name: stage.name, place: stage.place,
        stationCode,
        actorRole: stage.actor,
        signed: !!ev,
        signedAt: ev ? ev.created_at : null,
        fromStaff: ev && ev.from_staff_id ? q.staff.get(ev.from_staff_id) : null,
        toStaff: ev && ev.to_staff_id ? q.staff.get(ev.to_staff_id) : null,
        toPerson: ev && ev.to_person_id ? q.person.get(ev.to_person_id) : null,
        agentStaff: ev && ev.agent_staff_id ? q.staff.get(ev.agent_staff_id) : null,
        note: ev ? ev.note : null,
        selfHash: ev ? ev.self_hash : null,
      };
    });
  }

  // ---------- 查询：岗位最小可见的儿童档案 ----------
  function childProfileForRole(regId, role, viewer) {
    const reg = mustReg(regId);
    const child = q.child.get(reg.child_id);
    const flight = q.flight.get(reg.flight_id);
    const escort = q.person.get(reg.escort_id);
    const auth = q.activeAuth.get(regId);
    const pickup = auth ? q.person.get(auth.person_id) : null;
    const full = {
      codeName: child.code_name,
      flightNo: flight.flight_no,
      seat: flight.seat,
      ageBand: child.age_band,
      from: flight.from_code,
      to: flight.to_code,
      specialCare: child.special_care,
      medNotes: child.med_notes || '',
      escortName: escort.name,
      escortIdMasked: maskId(escort.id_number),
      escortPhoneMasked: maskPhone(escort.phone),
      pickupName: pickup ? pickup.name : '',
      pickupIdMasked: pickup ? maskId(pickup.id_number) : '',
      pickupPhoneMasked: pickup ? maskPhone(pickup.phone) : '',
    };
    let keys = FIELD_VISIBILITY[role] || [];
    // 到达站接待员在领取环节可看接机电话；非本人的接机场景下不加权
    if (role === 'station' && viewer && viewer.station_code) {
      keys = keys.concat(SELF_PICKUP_EXTRA);
    }
    const out = {};
    for (const k of new Set(keys)) out[k] = full[k];
    out._hidden = Object.keys(full).filter((k) => !(k in out)); // 便于界面明示"按岗位隐藏"
    return out;
  }

  // ---------- 查询：下一责任人（交接页大字） ----------
  function nextResponsible(regId) {
    const tl = timeline(regId);
    const next = tl.find((s) => !s.signed);
    if (!next) return { done: true, text: '交接链已闭环：儿童已由授权接机人领取' };
    const reg = q.reg.get(regId);
    const flight = q.flight.get(reg.flight_id);
    const stationName = next.stationCode;
    return {
      done: false,
      stageKey: next.key,
      stageName: next.name,
      place: next.place,
      station: stationName,
      actorRole: next.actorRole,
      text: `下一责任人：${next.name}（${stationName} · ${next.place}）`,
      flight: { no: flight.flight_no, seat: flight.seat, from: flight.from_code, to: flight.to_code, status: flight.status, divertedTo: flight.diverted_to },
    };
  }

  // ---------- 内部：段级权限 ----------
  function assertStagePermission(stage, staff, stationCode) {
    if (stage.actor !== staff.role) {
      throw new DomainError('ROLE_DENIED', `该段须由 ${stage.actor} 岗位签收，当前为 ${staff.role}`);
    }
    // 跨站约束：地面/柜台/到达站按站隔离；乘务组随机，不做站点限制
    if (staff.role !== 'crew') {
      if (staff.station_code !== stationCode) {
        throw new DomainError('STATION_DENIED',
          `跨站操作被拒绝：该段发生在 ${stationCode}，当前账号属于 ${staff.station_code}`);
      }
    }
  }

  // ---------- 核心：逐段签收 ----------
  // 签收人 = 本段接收方本人；交出方由上一段记录自动派生，不得自报，保证两段签名首尾相接。
  //   seq0 柜台签发：checkin 核验送机人，指定出发站地面接收人
  //   seq1 地面签收：须为 seq0 指定的地面人员本人
  //   seq2 乘务签收：from = seq1 地面
  //   seq3 到达地面签收：from = seq2 乘务，站点为实际到达站（改降后随之改变）
  //   seq4 到达领取：station 接待员监交，授权码+接机人证件双验，from = seq3 地面
  function signStage({ regId, stageKey, staffId, groundStaffId = null, toPersonId = null,
                       authCode = null, pickupIdNumber = null, escortVerified = false, note = '' }) {
    const seq = STAGE_KEYS.indexOf(stageKey);
    if (seq < 0) throw new DomainError('BAD_STAGE', '未知交接段');
    const stage = STAGES[seq];

    const body = () => {
      const staff = mustStaff(staffId);
      const reg = mustReg(regId);
      const flight = q.flight.get(reg.flight_id);
      const actualTo = flight.status === 'DIVERTED' && flight.diverted_to ? flight.diverted_to : flight.to_code;
      const stationCode = seq <= 2 ? flight.from_code : actualTo;

      // 1) 岗位 + 跨站
      assertStagePermission(stage, staff, stationCode);

      // 2) 顺序：必须从 0 开始连续；前置段未签收 -> 拒绝跳段
      let prevEvent = null;
      if (seq > 0) {
        prevEvent = q.signedAtStage.get(regId, seq - 1);
        if (!prevEvent) throw new DomainError('OUT_OF_ORDER', `上一段（${STAGES[seq - 1].name}）尚未签收，不得跳到本段`);
      }

      // 3) 重复签收
      if (q.signedAtStage.get(regId, seq)) {
        throw new DomainError('ALREADY_SIGNED', '本段已存在有效签收记录，不得重复签收');
      }

      let fromStaffId = null;
      let toStaffIdVal = null;
      let toPerson = null;
      let usedAuthVersion = null;

      if (seq === 0) {
        if (!escortVerified) {
          throw new DomainError('ESCORT_NOT_VERIFIED', '须先核验送机人身份原件后才可签发交接单');
        }
        const ground = groundStaffId ? mustStaff(groundStaffId) : null;
        if (!ground || ground.role !== 'ground' || ground.station_code !== flight.from_code) {
          throw new DomainError('BAD_NEXT_PARTY', '须指定本站地面人员作为首位接收人');
        }
        fromStaffId = staff.id;       // 柜台交出
        toStaffIdVal = ground.id;     // 指定地面接收人（须由其本人在下一段签收）
      } else if (seq === 1) {
        if (prevEvent.to_staff_id !== staff.id) {
          throw new DomainError('PARTY_MISMATCH', '只有交接单指定的地面接收人本人可签收本段');
        }
        fromStaffId = prevEvent.from_staff_id; // 柜台
        toStaffIdVal = staff.id;
      } else if (seq === 4) {
        // 到达领取：授权码 + 接机人证件双重核验
        const auth = q.activeAuth.get(regId);
        if (!auth) throw new DomainError('NO_ACTIVE_AUTH', '无有效接机授权');
        if (!authCode || hashAuthCode(authCode) !== auth.auth_code_hash) {
          throw new DomainError('AUTH_CODE_INVALID', '接机授权码无效（可能已因授权变更而失效）');
        }
        toPerson = toPersonId ? q.person.get(toPersonId) : null;
        if (!toPerson || toPerson.id !== auth.person_id) {
          throw new DomainError('PICKUP_PERSON_MISMATCH', '接机人与当前授权不一致');
        }
        if (!pickupIdNumber || pickupIdNumber !== toPerson.id_number) {
          throw new DomainError('ID_MISMATCH', '现场证件与授权接机人证件不一致，转入异常路径处理');
        }
        fromStaffId = prevEvent.to_staff_id; // 到达地面交出
        toStaffIdVal = null;
        usedAuthVersion = auth.version;
      } else {
        // seq2 乘务 / seq3 到达地面：接收人本人签收，交出方为上一段接收人
        fromStaffId = prevEvent.to_staff_id;
        toStaffIdVal = staff.id;
      }

      // 4) 追加事件 + 哈希链（两名工作人员同时交接时，部分唯一索引让第二个事务失败）
      const last = db.prepare(
        "SELECT self_hash FROM handoff_events WHERE registration_id=? ORDER BY stage_seq DESC, created_at DESC LIMIT 1"
      ).get(regId);
      const prevHash = last ? last.self_hash : null;
      const eventId = genId('ev');
      const createdAt = nowIso();
      const payload = [regId, seq, stageKey, fromStaffId || '', staff.id, toPerson ? toPerson.id : '', usedAuthVersion ?? '', createdAt, note].join('|');
      const selfHash = hashEvent(payload, prevHash);

      db.prepare(`INSERT INTO handoff_events
        (id, registration_id, stage_seq, stage_key, flight_id, station_code,
         from_staff_id, to_staff_id, to_person_id, agent_staff_id, auth_version,
         result, note, created_at, prev_hash, self_hash)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        eventId, regId, seq, stageKey, reg.flight_id, stationCode,
        fromStaffId, toStaffIdVal, toPerson ? toPerson.id : null,
        staff.id, usedAuthVersion,
        'SIGNED', note || null, createdAt, prevHash, selfHash
      );

      if (seq === 4) {
        db.prepare("UPDATE pickup_authorizations SET status='USED' WHERE id=?").run(q.activeAuth.get(regId).id);
        db.prepare("UPDATE registrations SET status='COMPLETED' WHERE id=?").run(regId);
      } else if (reg.status === 'OPEN') {
        db.prepare("UPDATE registrations SET status='IN_CHAIN' WHERE id=?").run(regId);
      }
      return { id: eventId, seq, stageKey, selfHash, stationCode };
    };

    try {
      return tx(body);
    } catch (e) {
      if (e instanceof DomainError) throw e;
      if (String(e.message).includes('UNIQUE') || String(e.message).includes('constraint')) {
        throw new DomainError('CONCURRENT_SIGN', '本段已有有效签收（并发交接仅允许一条记录）');
      }
      throw e;
    }
  }

  // 柜台核验送机人后签发（seq=0 的语义化入口）
  function checkinIssue({ regId, checkinStaffId, groundStaffId, escortIdNumber, note = '' }) {
    const reg = mustReg(regId);
    const escort = q.person.get(reg.escort_id);
    if (!escort || escort.id_number !== escortIdNumber) {
      // 核验失败：登记异常，不签发
      raiseException({ regId, type: 'ID_MISMATCH', staffId: checkinStaffId, detail: '柜台核验送机人证件与登记不一致，交接单未签发' });
      throw new DomainError('ID_MISMATCH', '送机人证件与登记不一致，已登记异常，不予签发');
    }
    return signStage({
      regId, stageKey: 'CHECKIN', staffId: checkinStaffId, groundStaffId,
      escortVerified: true, note: note || '送机人身份原件核验通过，签发交接单',
    });
  }

  // 拒收（不推进链，记录留痕，常与异常联动）
  function rejectStage({ regId, stageKey, staffId, reason }) {
    const seq = STAGE_KEYS.indexOf(stageKey);
    const stage = STAGES[seq];
    return tx(() => {
      const staff = mustStaff(staffId);
      const reg = mustReg(regId);
      const flight = q.flight.get(reg.flight_id);
      const stationCode = seq <= 2 ? flight.from_code : (flight.diverted_to || flight.to_code);
      assertStagePermission(stage, staff, stationCode);
      const last = db.prepare("SELECT self_hash FROM handoff_events WHERE registration_id=? ORDER BY created_at DESC LIMIT 1").get(regId);
      const createdAt = nowIso();
      const payload = ['REJECT', regId, seq, staff.id, reason, createdAt].join('|');
      const selfHash = hashEvent(payload, last ? last.self_hash : null);
      const id = genId('ev');
      db.prepare(`INSERT INTO handoff_events
        (id, registration_id, stage_seq, stage_key, flight_id, station_code,
         from_staff_id, result, note, created_at, prev_hash, self_hash)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        id, regId, seq, stageKey, reg.flight_id, stationCode, staff.id,
        'REJECTED', reason, createdAt, last ? last.self_hash : null, selfHash);
      return { id, rejected: true };
    });
  }

  // ---------- 接机授权变更：旧码立即失效 ----------
  function changePickup({ regId, staffId, newPersonId, reason, notifyOld = true, code = null }) {
    return tx(() => {
      const staff = mustStaff(staffId);
      if (staff.role !== 'station' && staff.role !== 'checkin') {
        throw new DomainError('ROLE_DENIED', '仅到达站值班经理或始发柜台可发起授权变更');
      }
      const reg0 = mustReg(regId);
      const flt0 = q.flight.get(reg0.flight_id);
      const arriveStation = flt0.status === 'DIVERTED' && flt0.diverted_to ? flt0.diverted_to : flt0.to_code;
      if (staff.role === 'station' && staff.station_code !== arriveStation) {
        throw new DomainError('STATION_DENIED', `跨站授权变更被拒绝：接待员须属实际到达站 ${arriveStation}`);
      }
      const reg = reg0;
      const person = q.person.get(newPersonId);
      if (!person) throw new DomainError('PERSON_INVALID', '新接机人不存在');

      const current = q.activeAuth.get(regId);
      const nextVersion = current ? current.version + 1 : 1;
      if (current) {
        // 旧码失效：同一事务内先撤销旧版本
        db.prepare("UPDATE pickup_authorizations SET status='REVOKED', revoked_at=?, revoke_reason=? WHERE id=?")
          .run(nowIso(), reason || '接机人更换', current.id);
      }
      const newCode = code || genAuthCode();
      const id = genId('auth');
      db.prepare(`INSERT INTO pickup_authorizations
        (id, registration_id, version, person_id, auth_code_hash, auth_code_hint, status, issued_at)
        VALUES (?,?,?,?,?,?, 'ACTIVE', ?)`)
        .run(id, regId, nextVersion, person.id, hashAuthCode(newCode), codeHint(newCode), nowIso());

      raiseException({
        regId, type: 'PICKUP_CHANGE', staffId: staff.id,
        detail: `接机授权变更为 v${nextVersion}：${person.name}；旧版本${current ? ` v${current.version}（${current.auth_code_hint}）已立即失效` : ''}。原因：${reason || '家属申请'}`,
        response: `已向新接机人 ${maskPhone(person.phone)} 发送 v${nextVersion} 授权码 ${codeHint(newCode)}；旧码核销。`,
      });

      // 短信模拟适配器：发给新接机人；可选通知旧接机人家属
      smsAdapter.send({
        registrationId: regId, phone: person.phone, template: 'PICKUP_AUTH_NEW',
        body: `【UMNR模拟】您被登记为儿童接机人（v${nextVersion}），到达站凭本码与证件领取：${newCode}。请保密。`,
      });
      if (notifyOld && current) {
        const oldPerson = q.person.get(current.person_id);
        smsAdapter.send({
          registrationId: regId, phone: oldPerson.phone, template: 'PICKUP_AUTH_REVOKED',
          body: `【UMNR模拟】原接机授权（v${current.version}）已失效，请勿前往领取。`,
        });
      }
      return { version: nextVersion, code: newCode, hint: codeHint(newCode), personId: person.id };
    });
  }

  // ---------- 异常路径 ----------
  function raiseException({ regId, type, staffId = 'SYSTEM', detail, flightId = null, response = null }) {
    const reg = mustReg(regId);
    const id = genId('ex');
    const staff = staffId === 'SYSTEM' ? null : mustStaff(staffId);
    const fltX = q.flight.get(reg.flight_id);
    // 乘务员在机上报航班类异常时，站点记实际到达站（改降后为改降站），而非机队码
    const stationCode = staff && staff.role !== 'crew'
      ? staff.station_code
      : (fltX.diverted_to || fltX.to_code);
    db.prepare(`INSERT INTO exception_events (id, registration_id, flight_id, type, station_code, raised_by, detail, created_at)
      VALUES (?,?,?,?,?,?,?,?)`)
      .run(id, regId, flightId || reg.flight_id, type, stationCode, staffId, detail, nowIso());
    if (response) addExceptionActionInternal(id, 'RESPONSE', staffId, response);
    return id;
  }

  function addExceptionActionInternal(exceptionId, kind, actor, text) {
    db.prepare(`INSERT INTO exception_actions (id, exception_id, kind, actor, text, created_at)
      VALUES (?,?,?,?,?,?)`).run(genId('exa'), exceptionId, kind, actor, text, nowIso());
  }
  function respondException({ exceptionId, staffId, text }) {
    const staff = mustStaff(staffId);
    addExceptionActionInternal(exceptionId, 'RESPONSE', staff.id, text);
  }
  function resolveException({ exceptionId, staffId, summary }) {
    const staff = mustStaff(staffId);
    addExceptionActionInternal(exceptionId, 'RESOLVE', staff.id, `${summary}〔闭环〕`);
  }

  function exceptionsOf(regId) {
    const rows = db.prepare('SELECT * FROM exception_events WHERE registration_id=? ORDER BY created_at').all(regId);
    return rows.map((r) => ({
      ...r,
      actions: db.prepare('SELECT * FROM exception_actions WHERE exception_id=? ORDER BY created_at').all(r.id),
      resolved: db.prepare("SELECT 1 FROM exception_actions WHERE exception_id=? AND kind='RESOLVE' LIMIT 1").get(r.id) ? true : false,
    }));
  }

  // 轮询航班适配器：落地延误/改降动态并触发应急路径
  function pollFlightUpdate(regId, staffId = 'SYSTEM') {
    const reg = mustReg(regId);
    const flight = q.flight.get(reg.flight_id);
    const live = flightAdapter.getStatus(flight);
    if (live.status === 'DELAYED' && flight.status !== 'DELAYED') {
      db.prepare("UPDATE flights SET status='DELAYED' WHERE id=?").run(flight.id);
      raiseException({
        regId, type: 'DELAY', staffId,
        detail: `航班 ${flight.flight_no} 延误，预计起飞 ${live.depEstimate}（${live.reason || '天气/流控'}）`,
        response: '通知乘务与到达站顺延交接安排；向送机/接机家属发送延误短信；儿童由地面人员继续陪护。',
      });
      notifyFamily(regId, 'FLIGHT_DELAY', `航班 ${flight.flight_no} 延误，预计起飞 ${live.depEstimate}，孩子有人陪护，请放心。`);
    } else if (live.status === 'DIVERTED' && flight.status !== 'DIVERTED') {
      const to = live.divertedTo;
      db.prepare("UPDATE flights SET status='DIVERTED', diverted_to=? WHERE id=?").run(to, flight.id);
      raiseException({
        regId, type: 'DIVERT', staffId,
        detail: `航班 ${flight.flight_no} 改降 ${to}（原目的 ${flight.to_code}）`,
        response: `交接链后续两段自动改至 ${to} 站地面/接待；${to} 站地面接机构建跨站护送安排；通知家属改降与新领取地点。`,
      });
      notifyFamily(regId, 'FLIGHT_DIVERT', `航班临时改降 ${to}，孩子将由 ${to} 站人员照料，新领取地点请等待工作人员电话。`);
    } else if (live.status === 'DEPARTED' && flight.status !== 'DEPARTED') {
      db.prepare("UPDATE flights SET status='DEPARTED' WHERE id=?").run(flight.id);
    } else if (live.status === 'ARRIVED' && flight.status !== 'ARRIVED' && flight.status !== 'DIVERTED') {
      db.prepare("UPDATE flights SET status='ARRIVED' WHERE id=?").run(flight.id);
    }
    return q.flight.get(reg.flight_id);
  }

  function notifyFamily(regId, template, body) {
    const reg = q.reg.get(regId);
    const escort = q.person.get(reg.escort_id);
    const auth = q.activeAuth.get(regId);
    const phones = [escort.phone];
    if (auth) phones.push(q.person.get(auth.person_id).phone);
    for (const phone of new Set(phones)) {
      smsAdapter.send({ registrationId: regId, phone, template, body: `【UMNR模拟】${body}` });
    }
  }

  // 儿童身体不适 / 换班 / 联系不上家属的语义化登记入口
  function reportUnwell({ regId, staffId, symptom }) {
    return raiseException({
      regId, type: 'CHILD_UNWELL', staffId, detail: `儿童身体不适：${symptom}`,
      response: '立即由持证乘务/地面人员看护，广播寻医，评估是否继续行程；同步值班经理并通知家属。',
    });
  }
  function reportShiftChange({ regId, staffId, relieverStaffId, stageKey }) {
    const reliever = mustStaff(relieverStaffId);
    return raiseException({
      regId, type: 'SHIFT_CHANGE', staffId,
      detail: `交接人临时换班：${STAGES.find((s) => s.key === stageKey).name} 改由 ${reliever.name}（${reliever.station_code}）接续`,
      response: '换班双方在交接单备注，接班人以本人账号签收；责任以实际签收记录为准。',
    });
  }
  function reportFamilyUnreachable({ regId, staffId, attempts }) {
    const id = raiseException({
      regId, type: 'FAMILY_UNREACHABLE', staffId, detail: `多次联系接机家属未果：${attempts}`,
      response: '启动备用联系人与值班经理审批的临时看护流程；儿童不离开到达站受控区域；继续定时重试联系。',
    });
    return id;
  }

  function smsLog(regId) {
    return db.prepare('SELECT * FROM sms_messages WHERE registration_id=? ORDER BY created_at').all(regId);
  }

  // 交接单/授权/签名的汇总（交付视图用）
  function handoffPackage(regId, role = 'station', viewer = null) {
    const reg = mustReg(regId);
    const child = q.child.get(reg.child_id);
    const flightRow = q.flight.get(reg.flight_id);
    const escort = q.person.get(reg.escort_id);
    const auths = db.prepare('SELECT * FROM pickup_authorizations WHERE registration_id=? ORDER BY version').all(regId);
    return {
      registration: {
        id: reg.id, formNo: reg.handoff_form_no, status: reg.status, createdAt: reg.created_at,
      },
      profile: childProfileForRole(regId, role, viewer),
      flight: {
        flightNo: flightRow.flight_no, seat: flightRow.seat, from: flightRow.from_code, to: flightRow.to_code,
        schedDep: flightRow.sched_dep, schedArr: flightRow.sched_arr,
        status: flightRow.status, divertedTo: flightRow.diverted_to,
      },
      escort: role === 'checkin' ? { name: escort.name, idMasked: maskId(escort.id_number), phoneMasked: maskPhone(escort.phone) } : null,
      timeline: timeline(regId),
      authorizations: auths.map((a) => ({
        version: a.version, personName: q.person.get(a.person_id).name,
        status: a.status, hint: a.auth_code_hint, issuedAt: a.issued_at, revokedAt: a.revoked_at, reason: a.revoke_reason,
      })),
      exceptions: exceptionsOf(regId),
      sms: smsLog(regId),
      child, // 内部使用，视图层不得直接渲染真实名字段
    };
  }

  return {
    signStage, checkinIssue, rejectStage,
    changePickup, timeline, nextResponsible, childProfileForRole,
    pollFlightUpdate, raiseException, respondException, resolveException, exceptionsOf,
    reportUnwell, reportShiftChange, reportFamilyUnreachable,
    smsLog, handoffPackage, notifyFamily,
  };
}

module.exports = { createService, DomainError, hashAuthCode };
