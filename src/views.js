'use strict';
// 交接页视图：大字 Hero（儿童代号/航班/下一责任人）、旅客档案（岗位遮罩）、
// 航段时间线、交接签名、授权变更、异常通知与应急路径、到达领取、遮罩证件。
const crypto = require('node:crypto');
const { esc, fmtTime, EX_TYPES, FIELD_LABELS, STAGES } = require('./util');
const { roleName, statusBadge } = require('./render');

function staffAt(db, role, station) {
  return db.prepare('SELECT * FROM staff WHERE active=1 AND role=? AND station_code=?').all(role, station);
}

function canActOn(stage, staff, flight, tl) {
  if (!staff) return { ok: false, why: '请先在右上角选择登录视角' };
  const actualTo = flight.status === 'DIVERTED' ? flight.diverted_to : flight.to_code;
  const stationCode = stage.seq <= 2 ? flight.from_code : actualTo;
  if (stage.actorRole !== staff.role) return { ok: false, why: `须由「${roleName(stage.actorRole)}」签收` };
  if (staff.role !== 'crew' && staff.station_code !== stationCode) {
    return { ok: false, why: `须由 ${stationCode} 站账号操作（当前 ${staff.station_code} 站，跨站禁止）` };
  }
  if (stage.seq === 1) {
    const ev0 = tl.find((e) => e.seq === 0);
    if (ev0 && ev0.toStaff && ev0.toStaff.id !== staff.id) {
      return { ok: false, why: `仅交接单指定的 ${ev0.toStaff.name} 本人可签收` };
    }
  }
  return { ok: true, stationCode };
}

function actionPanel(ctx, reg, flight, tl, staff, childCode) {
  const next = tl.find((s) => !s.signed);
  if (!next) return `<div class="done-banner">✔ 交接链已闭环：${esc(childCode)} 已由授权接机人安全领取</div>`;
  const can = canActOn(next, staff, flight, tl);
  const head = `<div class="card"><h2>本段签收操作 · ${esc(next.name)}</h2>
    <p class="small">地点：${esc(next.stationCode)} 站 · ${esc(next.place)}；时间以服务端签收时刻为准并写入不可覆盖链。</p>`;
  if (!staff) return head + `<p>${esc(can.why)}</p></div>`;
  if (!can.ok) return head + `<p class="hidden-note">当前视角无法操作：${esc(can.why)}</p></div>`;

  let form = '';
  if (next.seq === 0) {
    const grounds = staffAt(ctx.db, 'ground', flight.from_code);
    form = `<form method="post" action="/checkin">
      <input type="hidden" name="reg" value="${esc(reg.id)}">
      <label>核验送机人证件号（与登记比对，不一致将进异常且不签发）</label>
      <input name="escortIdNumber" placeholder="演练送机人证件号（见档案，仅柜台可见）" required>
      <label>指定接收的本站地面人员</label>
      <select name="groundStaffId">${grounds.map((g) => `<option value="${esc(g.id)}">${esc(g.name)}（${esc(g.station_code)}）</option>`).join('')}</select>
      <button class="btn btn-orange" type="submit">核验通过并签发交接单</button></form>`;
  } else if (next.seq === 4) {
    const auth = ctx.db.prepare("SELECT pa.*, p.name pname FROM pickup_authorizations pa JOIN persons p ON p.id=pa.person_id WHERE pa.registration_id=? AND pa.status='ACTIVE' ORDER BY version DESC LIMIT 1").get(reg.id);
    form = `<form method="post" action="/pickup">
      <input type="hidden" name="reg" value="${esc(reg.id)}">
      <input type="hidden" name="toPersonId" value="${esc(auth.person_id)}">
      <div class="kv"><dt>当前授权接机人</dt><dd>${esc(auth.pname)}（v${auth.version}，提示 ${esc(auth.auth_code_hint)}）</dd></div>
      <label style="margin-top:10px">接机授权码（旧码已随授权变更失效）</label>
      <input name="authCode" placeholder="6 位授权码" required>
      <label>现场证件号（与授权证件比对）</label>
      <input name="pickupIdNumber" placeholder="接机人证件号" required>
      <button class="btn btn-orange" type="submit">双验通过，交付儿童</button></form>`;
  } else {
    const label = next.seq === 1 ? '我是指定地面人员，确认接收儿童'
      : next.seq === 2 ? '乘务长确认从地面接收儿童并登机'
      : '到达站地面确认从乘务组接收儿童';
    form = `<form method="post" action="/sign">
      <input type="hidden" name="reg" value="${esc(reg.id)}">
      <input type="hidden" name="stage" value="${esc(next.key)}">
      <label>签收备注（可选）</label><input name="note" placeholder="如：儿童状态平稳 / 随身包已清点">
      <button class="btn btn-navy" type="submit">${esc(label)}</button></form>`;
  }
  return head + form + '</div>';
}

function profileCard(profile) {
  const rows = Object.keys(profile).filter((k) => !k.startsWith('_')).map((k) =>
    `<dt>${esc(FIELD_LABELS[k] || k)}</dt><dd>${esc(profile[k])}</dd>`).join('');
  return `<div class="card"><h2>① 旅客档案（按岗位最小可见）</h2>
    <dl class="kv">${rows}</dl>
    <p class="hidden-note">本视角已隐去 ${profile._hidden.length} 个字段：${profile._hidden.map((h) => FIELD_LABELS[h] || h).join('、')}。儿童真实姓名不对任何岗位界面下发。</p>
  </div>`;
}

function timelineCard(tl, flight) {
  const items = tl.map((s) => {
    const cls = s.signed ? 'signed' : (tl.findIndex((x) => !x.signed) === s.seq ? 'now' : '');
    let who = '';
    if (s.signed) {
      if (s.seq === 4) who = `交付给接机人 <b>${esc(s.toPerson.name)}</b>；接待监交：${esc(s.agentStaff.name)}`;
      else if (s.seq === 0) who = `签发：${esc(s.toStaff ? s.fromStaff.name : '')} → 指定接收：<b>${esc(s.toStaff ? s.toStaff.name : '')}</b>`;
      else if (s.seq === 1) who = `交出：${esc(s.fromStaff.name)} → 地面签收：<b>${esc(s.toStaff.name)}</b>`;
      else who = `交出：${esc(s.fromStaff.name)} → 签收：<b>${esc(s.toStaff.name)}</b>`;
      if (s.note) who += `<br><span class="small">备注：${esc(s.note)}</span>`;
    } else if (cls === 'now') who = `<span class="nowtag">▶ 当前等待此段</span>`;
    else who = '<span class="small">未到达</span>';
    return `<div class="step ${cls}">
      <div class="n">${s.seq + 1}</div>
      <div><div class="name">${esc(s.name)}</div>
        <div class="sub">${esc(s.stationCode)} · ${esc(s.place)}<br>${who}</div>
        ${s.signed ? `<div class="hash">链哈希 ${esc((s.selfHash || '').slice(0, 18))}…</div>` : ''}
      </div>
      <div class="when">${s.signed ? `<b>已签收</b>${fmtTime(s.signedAt)}` : '—'}</div>
    </div>`;
  }).join('');
  return `<div class="card"><h2>② 航段时间线 · ${esc(flight.flight_no)} ${esc(flight.from_code)}→${esc(flight.to_code)}${flight.diverted_to ? '（改降 ' + esc(flight.diverted_to) + '）' : ''}</h2>
    <div class="steps">${items}</div></div>`;
}

function signaturesCard(tl) {
  const rows = tl.filter((s) => s.signed).map((s) => {
    const signer = s.seq === 4 ? `${s.agentStaff.name}（监交）/ ${s.toPerson.name}（接机人）`
      : s.seq === 0 ? s.fromStaff.name
      : s.toStaff.name;
    return `<tr><td>${s.seq + 1}</td><td>${esc(s.name)}</td><td>${esc(s.stationCode)}</td>
      <td>${esc(signer)}</td><td>${fmtTime(s.signedAt)}</td>
      <td class="hash">${esc(s.selfHash.slice(0, 16))}</td></tr>`;
  }).join('');
  return `<div class="card"><h2>③ 交接签名（逐段留痕，不可覆盖）</h2>
    ${rows ? `<table><tr><th>#</th><th>环节</th><th>站</th><th>签收人</th><th>时间</th><th>哈希</th></tr>${rows}</table>`
      : '<p class="small">尚无签收。</p>'}</div>`;
}

function authCard(ctx, reg, staff) {
  const auths = ctx.db.prepare(`SELECT pa.*, p.name pname FROM pickup_authorizations pa
    JOIN persons p ON p.id=pa.person_id WHERE pa.registration_id=? ORDER BY pa.version`).all(reg.id);
  const rows = auths.map((a) => `<tr>
    <td>v${a.version}</td><td>${esc(a.pname)}</td>
    <td><span class="tag ${a.status}">${({ ACTIVE: '有效', REVOKED: '已失效', USED: '已使用' })[a.status]}</span></td>
    <td>${esc(a.auth_code_hint)}</td><td>${fmtTime(a.issued_at)}</td>
    <td>${a.revoked_at ? fmtTime(a.revoked_at) + '<br><span class="small">' + esc(a.revoke_reason || '') + '</span>' : '—'}</td></tr>`).join('');
  const canChange = staff && (staff.role === 'station' || staff.role === 'checkin');
  const candidates = ctx.db.prepare("SELECT * FROM persons WHERE id NOT IN (SELECT person_id FROM pickup_authorizations WHERE registration_id=? AND status='ACTIVE')").all(reg.id);
  return `<div class="card"><h2>④ 接机授权与变更（旧码立即失效）</h2>
    <table><tr><th>版本</th><th>接机人</th><th>状态</th><th>码提示</th><th>签发</th><th>撤销/原因</th></tr>${rows}</table>
    ${canChange ? `<h3>发起授权变更（模拟）</h3><form method="post" action="/change-pickup" class="row2" style="display:block">
      <input type="hidden" name="reg" value="${esc(reg.id)}">
      <label>新接机人（虚构库内选择）</label><select name="newPersonId">
        ${candidates.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}｜${esc(p.phone)}</option>`).join('')}</select>
      <label>变更原因</label><input name="reason" value="家属电话申请更换接机人">
      <button class="btn btn-orange" type="submit">变更并使旧码失效</button></form>
      <p class="small">同一事务内旧版本置 REVOKED，新码经模拟短信适配器发出；用旧码领取将被拒。</p>`
    : '<p class="small">仅到达站值班经理/始发柜台可发起授权变更。</p>'}</div>`;
}

function exceptionsCard(ctx, reg, staff, exceptions) {
  const list = exceptions.map((e) => {
    const actions = e.actions.map((a) =>
      `<div class="ex-path"><span class="t">${a.kind === 'RESOLVE' ? '闭环 ✔' : '应急处置 →'}</span>
       <div class="small">${esc(a.actor === 'SYSTEM' ? '系统' : a.actor)} · ${fmtTime(a.created_at)}</div>
       <div>${esc(a.text)}</div></div>`).join('');
    return `<div class="ex-path">
      <div class="t">${EX_TYPES[e.type]} <span class="tag ${e.resolved ? 'RESOLVED' : 'UNRESOLVED'}">${e.resolved ? '已闭环' : '待处置'}</span></div>
      <div class="r">${esc(e.station_code)} 站 · ${esc(e.raised_by === 'SYSTEM' ? '航班模拟适配器' : e.raised_by)} · ${fmtTime(e.created_at)}</div>
      <div>${esc(e.detail)}</div>${actions}
      ${staff && !e.resolved ? `<form method="post" action="/resolve" style="margin-top:6px">
        <input type="hidden" name="reg" value="${esc(reg.id)}"><input type="hidden" name="exId" value="${esc(e.id)}">
        <input name="summary" placeholder="闭环说明（如：儿童已随地面人员到达 SZX 接待区）">
        <button class="btn btn-ghost" type="submit">记录闭环</button></form>` : ''}
    </div>`;
  }).join('');
  return `<div class="card exception-box"><h2>⑤ 异常路径专区</h2>
    ${list || '<p class="small">暂无异常。</p>'}
    <h3>登记新异常（演练）</h3>
    <div class="row2">
      <form method="post" action="/exception">
        <input type="hidden" name="reg" value="${esc(reg.id)}"><input type="hidden" name="type" value="CHILD_UNWELL">
        <label>儿童身体不适</label><input name="detail" placeholder="症状，如：耳痛、精神差">
        <button class="btn btn-blue" type="submit">登记不适并启动陪护</button></form>
      <form method="post" action="/exception">
        <input type="hidden" name="reg" value="${esc(reg.id)}"><input type="hidden" name="type" value="FAMILY_UNREACHABLE">
        <label>联系不上家属</label><input name="detail" placeholder="拨打情况，如：3 次无人接听">
        <button class="btn btn-blue" type="submit">登记并启动备用联系人</button></form>
      <form method="post" action="/exception">
        <input type="hidden" name="reg" value="${esc(reg.id)}"><input type="hidden" name="type" value="SHIFT_CHANGE">
        <label>交接人临时换班</label><input name="detail" placeholder="如：李地勤换赵地勤，接班人须本人账号签收">
        <button class="btn btn-blue" type="submit">登记换班</button></form>
      <form method="post" action="/exception">
        <input type="hidden" name="reg" value="${esc(reg.id)}"><input type="hidden" name="type" value="ID_MISMATCH">
        <label>证件不一致</label><input name="detail" placeholder="现场证件与登记不符情况">
        <button class="btn btn-blue" type="submit">登记证件异常（暂缓交接）</button></form>
    </div>
    <p class="small" style="margin-top:10px">航班延误/改降由<b>航班模拟适配器</b>推送：
      <form method="post" action="/sim-delay" style="display:inline"><input type="hidden" name="reg" value="${esc(reg.id)}">
      <button class="btn btn-ghost" type="submit">模拟一次「航班延误」推送</button></form>
      <form method="post" action="/sim-divert" style="display:inline;margin-left:8px"><input type="hidden" name="reg" value="${esc(reg.id)}">
      <input name="divertedTo" value="HGH" style="width:70px;display:inline-block;margin:0 4px" maxlength="4">
      <button class="btn btn-orange" type="submit">模拟「改降」到该站</button></form>
      <form method="post" action="/poll" style="display:inline;margin-left:8px"><input type="hidden" name="reg" value="${esc(reg.id)}">
      <button class="btn btn-ghost" type="submit">立即拉取航班动态</button></form>
    </p></div>`;
}

function smsCard(sms) {
  const items = sms.map((m) =>
    `<div class="sms"><b>${esc(m.template)}</b> → ${esc(m.to_phone_masked)} · ${fmtTime(m.created_at)}<br>${esc(m.body)}</div>`
  ).join('');
  return `<div class="card"><h2>⑥ 异常通知（模拟短信适配器）</h2>${items || '<p class="small">暂无通知。</p>'}</div>`;
}

function docsCard(ctx, reg) {
  const docs = ctx.db.prepare('SELECT * FROM masked_docs WHERE registration_id=?').all(reg.id);
  return `<div class="card"><h2>遮罩证件图（本地虚构件）</h2>
    <div class="row2">${docs.map((d) =>
      `<div><p class="small">${d.doc_kind === 'ESCORT_ID' ? '送机人凭证' : '接机人凭证'}</p>
      <img class="docframe" src="/doc/${esc(d.id)}" alt="masked doc"></div>`).join('')}</div></div>`;
}

function hero(reg, flight, next, codeName) {
  const actualTo = flight.status === 'DIVERTED' ? flight.diverted_to : flight.to_code;
  return `<div class="hero">
    <div class="code">儿童代号：${esc(codeName)} ${statusBadge(reg, flight)}</div>
    <div class="flight">${esc(flight.flight_no)}　${esc(flight.from_code)} → ${esc(actualTo)}　座位 <span class="seat">${esc(flight.seat)}</span></div>
    <div class="meta">交接单 ${esc(reg.handoff_form_no)}　计划 ${fmtTime(flight.sched_dep)} / ${fmtTime(flight.sched_arr)}${flight.diverted_to ? '　<b style="color:#B45312">已改降 ' + esc(flight.diverted_to) + '，后续交接段自动切换至该站</b>' : ''}</div>
    <div class="next">${next.done ? '交接链已闭环 ✔' : `下一责任人：${esc(next.stageName)}`}
      ${!next.done ? `<span class="place">｜${esc(next.station)} 站 · ${esc(next.place)}</span>` : ''}</div>
  </div>`;
}

function renderCasePage(ctx, regId, staffId) {
  const svc = ctx.service;
  const reg = ctx.db.prepare('SELECT * FROM registrations WHERE id=?').get(regId);
  const child = ctx.db.prepare('SELECT * FROM children WHERE id=?').get(reg.child_id);
  const flight = ctx.db.prepare('SELECT * FROM flights WHERE id=?').get(reg.flight_id);
  const staff = staffId ? ctx.db.prepare('SELECT * FROM staff WHERE id=?').get(staffId) : null;
  const tl = svc.timeline(regId);
  const next = svc.nextResponsible(regId);
  const profile = svc.childProfileForRole(regId, staff ? staff.role : 'crew', staff);
  const exceptions = svc.exceptionsOf(regId);
  const sms = svc.smsLog(regId);
  const staffHidden = `<input type="hidden" name="staff" value="${esc(staff ? staff.id : '')}">`;
  const html = hero(reg, flight, next, child.code_name)
    + `<div class="grid"><div>${profileCard(profile)}${timelineCard(tl, flight)}${signaturesCard(tl)}${docsCard(ctx, reg)}</div>
       <div>${actionPanel(ctx, reg, flight, tl, staff, child.code_name)}${authCard(ctx, reg, staff)}${exceptionsCard(ctx, reg, staff, exceptions)}${smsCard(sms)}</div></div>`;
  // 所有 POST 动作都以当前登录视角执行：统一注入 staff hidden
  return html.replace(/(<form method="post"[^>]*>)/g, `$1${staffHidden}`);
}

module.exports = { renderCasePage };
