/* UM 交接系统前端 */
"use strict";

const state = {
  staff: [], flights: [], roles: {}, exceptionTypes: {},
  me: null,            // 当前工作人员(岗位最小可见由此决定)
  caseId: null,
  detail: null,
};

/* ---------------- 工具 ---------------- */
const $ = (sel, el = document) => el.querySelector(sel);
const app = $("#app");

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g,
    c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function api(path, opts = {}) {
  if (state.me && path.startsWith("/api/cases/") && !path.includes("?")) {
    path += `?role=${state.me.role}`;
  }
  const res = await fetch(path, {
    method: opts.method || "GET",
    headers: { "Content-Type": "application/json" },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || `请求失败 ${res.status}`);
    err.code = data.error;
    throw err;
  }
  return data;
}

function toast(msg, isErr = false) {
  const el = document.createElement("div");
  el.className = "toast" + (isErr ? " err" : "");
  el.textContent = msg;
  $("#toast-root").appendChild(el);
  setTimeout(() => el.remove(), 3600);
}

function modal(title, bodyHtml, onOk, okText = "确认") {
  const root = $("#modal-root");
  root.innerHTML = `
    <div class="overlay">
      <div class="modal">
        <h3>${esc(title)}</h3>
        <div class="m-body">${bodyHtml}</div>
        <div class="actions">
          <button data-act="cancel">取消</button>
          <button class="primary" data-act="ok">${esc(okText)}</button>
        </div>
      </div>
    </div>`;
  $(".overlay", root).addEventListener("click", e => {
    if (e.target.classList.contains("overlay")) root.innerHTML = "";
  });
  $('[data-act="cancel"]', root).onclick = () => (root.innerHTML = "");
  $('[data-act="ok"]', root).onclick = async () => {
    const vals = {};
    root.querySelectorAll("[name]").forEach(el => (vals[el.name] = el.value.trim()));
    try {
      await onOk(vals);
      root.innerHTML = "";
    } catch (e) {
      toast(e.message, true);
    }
  };
}

const field = (name, label, value = "", type = "text", placeholder = "") =>
  `<div class="field"><label>${esc(label)}</label>
   <input name="${name}" type="${type}" value="${esc(value)}" placeholder="${esc(placeholder)}"></div>`;

const selectField = (name, label, options) =>
  `<div class="field"><label>${esc(label)}</label>
   <select name="${name}">${options.map(([v, t]) => `<option value="${esc(v)}">${esc(t)}</option>`).join("")}</select></div>`;

/* ---------------- 初始化 ---------------- */
async function boot() {
  const b = await api("/api/bootstrap");
  Object.assign(state, { staff: b.staff, flights: b.flights, roles: b.roles, exceptionTypes: b.exception_types });
  const sel = $("#staff-select");
  sel.innerHTML = state.staff.map(s =>
    `<option value="${s.id}">${esc(s.name)} · ${esc(state.roles[s.role])}${s.station ? " · " + esc(s.station) : " · 随机组"}</option>`
  ).join("");
  state.me = state.staff[0];
  sel.onchange = () => {
    state.me = state.staff.find(s => s.id === Number(sel.value));
    route();
  };
  window.addEventListener("hashchange", route);
  route();
}

function navActive(key) {
  document.querySelectorAll("#topbar nav a").forEach(a =>
    a.classList.toggle("active", a.dataset.nav === key));
}

/* ---------------- 路由 ---------------- */
function route() {
  const hash = location.hash || "#/cases";
  const [, page, arg, tab] = hash.split("/");
  if (page === "cases" && arg === "new") return viewNewCase();
  if (page === "cases" && arg) return viewCaseDetail(Number(arg), tab || "handover");
  if (page === "ops") return viewOps();
  return viewCaseList();
}

/* ---------------- 案例列表 ---------------- */
async function viewCaseList() {
  navActive("cases");
  const { cases } = await api("/api/cases");
  app.innerHTML = `
    <div class="card">
      <h2>在管儿童案例</h2>
      ${cases.length === 0 ? '<p class="muted">暂无案例, 请先在「登记」页建案。</p>' : ""}
      ${cases.map(c => `
        <a class="case-row" href="#/cases/${c.id}">
          <span class="case-code">${esc(c.code)}</span>
          <span class="case-meta">
            <b>${esc(c.flight_no)}</b> ${esc(c.origin)} → ${esc(c.arrival_station)}
            · 座位 ${esc(c.seat)}
            <div class="muted">${esc(c.child_name)} · ${c.child_age}岁 · 送机 ${esc(c.sender_name)} → 接机 ${esc(c.receiver_name)}</div>
          </span>
          <span class="progress">${[1, 2, 3, 4].map(i =>
            `<i class="${c.progress >= i ? "done" : ""}"></i>`).join("")}</span>
          ${c.open_exceptions ? `<span class="chip orange">异常 ${c.open_exceptions}</span>` : ""}
          <span class="chip ${c.status === "COMPLETED" ? "ok" : ""}">${statusText(c.status)}</span>
        </a>`).join("")}
    </div>`;
}

function statusText(s) {
  return { OPEN: "待交接", IN_TRANSIT: "在途", COMPLETED: "已领取" }[s] || s;
}

/* ---------------- 登记 ---------------- */
function viewNewCase() {
  navActive("new");
  const flightOpts = state.flights.map(f =>
    [`${f.flight_no}|${f.flight_date}`, `${f.flight_no} · ${f.flight_date} · ${f.origin}→${f.destination}`]);
  app.innerHTML = `
    <div class="card">
      <h2>柜台登记 · 核验送机人身份后签发交接单</h2>
      <div class="notice">登记后系统签发接机授权码, 经模拟短信发送给送机人与接机人; 儿童证件以遮罩图存档。</div>
      <form id="new-case">
        <h3>儿童信息</h3>
        <div class="grid3">
          ${field("child_name", "儿童姓名")}
          ${field("child_age", "年龄", "", "number")}
          ${selectField("child_gender", "性别", [["男", "男"], ["女", "女"]])}
          ${selectField("doc_type", "证件类型", [["居民身份证", "居民身份证"], ["户口簿", "户口簿"], ["护照", "护照"]])}
          ${field("doc_number", "证件号码(虚构)")}
          ${field("seat", "座位号", "", "text", "如 12A")}
        </div>
        <div class="field"><label>特殊照顾说明</label>
          <textarea name="care_notes" rows="2" placeholder="过敏史 / 用药 / 情绪安抚要点等"></textarea></div>
        <h3>航班</h3>
        <div class="grid2">${selectField("flight", "航班", flightOpts)}</div>
        <h3>送机人(柜台核验身份)</h3>
        <div class="grid3">
          ${field("sender_name", "姓名")}${field("sender_phone", "手机")}
          ${field("sender_id_number", "证件号码(虚构)")}
          ${field("sender_relation", "与儿童关系", "父亲")}
        </div>
        <h3>接机人(到达站授权领取)</h3>
        <div class="grid3">
          ${field("receiver_name", "姓名")}${field("receiver_phone", "手机")}
          ${field("receiver_id_number", "证件号码(虚构)")}
          ${field("receiver_relation", "与儿童关系", "母亲")}
        </div>
        <button class="primary big-sign" type="submit">签发交接单</button>
      </form>
    </div>`;
  $("#new-case").onsubmit = async e => {
    e.preventDefault();
    const v = {};
    e.target.querySelectorAll("[name]").forEach(el => (v[el.name] = el.value.trim()));
    const [flight_no, flight_date] = v.flight.split("|");
    try {
      const r = await api("/api/cases", { method: "POST", body: { ...v, flight_no, flight_date } });
      toast(`已签发交接单, 儿童代号 ${r.code}`);
      location.hash = `#/cases/${r.id}`;
    } catch (err) { toast(err.message, true); }
  };
}

/* ---------------- 案例详情 ---------------- */
async function viewCaseDetail(id, tab) {
  navActive("cases");
  state.caseId = id;
  let d;
  try {
    d = await api(`/api/cases/${id}`);
  } catch (e) {
    app.innerHTML = `<div class="card"><p>${esc(e.message)}</p></div>`;
    return;
  }
  state.detail = d;
  const tabs = [
    ["handover", "交接"], ["profile", "旅客档案"], ["timeline", "航段时间线"],
    ["signatures", "交接签名"], ["auth", "授权变更"], ["exceptions", "异常通知"],
    ["pickup", "到达领取"],
  ];
  app.innerHTML = `
    ${heroHtml(d)}
    <div class="tabs">${tabs.map(([k, t]) =>
      `<a href="#/cases/${id}/${k}" class="${k === tab ? "active" : ""}">${t}</a>`).join("")}</div>
    <div id="tab-body"></div>`;
  const body = $("#tab-body");
  if (tab === "handover") tabHandover(body, d);
  else if (tab === "profile") tabProfile(body, d);
  else if (tab === "timeline") tabTimeline(body, d);
  else if (tab === "signatures") tabSignatures(body, d);
  else if (tab === "auth") tabAuth(body, d);
  else if (tab === "exceptions") tabExceptions(body, d);
  else if (tab === "pickup") tabPickup(body, d);
}

function heroHtml(d) {
  const p = d.profile, f = d.flight || {};
  const done = d.status === "COMPLETED";
  const next = d.next_responsible;
  const flightNote = f.status === "DIVERTED"
    ? `<span class="chip orange">已改降 ${esc(f.diverted_to)}</span>`
    : f.status === "DELAYED" ? `<span class="chip orange">延误, 预计 ${esc(f.est_arr)}</span>` : "";
  return `
    <div class="hero ${done ? "done" : ""}">
      <div>
        <div class="um-code">${esc(p.code)}</div>
        <div class="um-flight">${esc(f.flight_no || "")} ${flightNote}</div>
        <div class="um-route">${esc(f.origin || "")} → ${esc(d.arrival_station)}
          · 座位 ${esc(p.seat || "-")} · ${esc(f.flight_date || "")}</div>
      </div>
      <div class="next">
        ${done
          ? `<div class="label">交接完成</div><div class="person">已领取 ✓</div>
             <div class="where">全部四段签收完毕</div>`
          : next
            ? `<div class="label">下一责任人</div>
               <div class="person">${esc(next.name)} · ${esc(next.role_name)}</div>
               <div class="where">${esc(next.segment)}<br>${esc(next.location)}</div>`
            : `<div class="label">下一责任人</div><div class="person">待指派</div>`}
      </div>
    </div>`;
}

/* ----- 交接页 ----- */
function tabHandover(body, d) {
  const segs = d.segments;
  const nextSeg = segs.find(s => !s.signed);
  const canSign = nextSeg && state.me && nextSeg.key !== "ARRIVAL_TO_RECEIVER" &&
    state.me.role === roleFor(nextSeg) && stationOk(nextSeg);
  body.innerHTML = `
    <div class="card">
      <h2>交接链 · 每段须上一环节签收后方可进行</h2>
      <ul class="timeline">
        ${segs.map(s => `
          <li class="${s.signed ? "signed" : ""} ${s === nextSeg ? "current" : ""}">
            <div class="tl-label">${esc(s.label)}</div>
            <div class="tl-whenwhere">地点 <b>${esc(s.location)}</b> · 站点 <b>${esc(s.station)}</b>
              ${s.event ? ` · 时间 <b>${esc(s.event.created_at)}</b>` : ""}</div>
            ${s.event
              ? `<div class="tl-signer">签收: ${esc(s.event.signed_by_name)}(${esc(state.roles[s.event.signed_by_role] || s.event.signed_by_role)}) — ${esc(s.event.from_label)} → ${esc(s.event.to_label)}</div>`
              : `<div class="tl-pending">待签收</div>`}
          </li>`).join("")}
      </ul>
      <div style="margin-top:14px">
        ${d.status === "COMPLETED"
          ? `<span class="chip ok">交接链已完成, 儿童已领取</span>`
          : nextSeg && nextSeg.key === "ARRIVAL_TO_RECEIVER"
            ? `<span class="chip orange">最终领取请到「到达领取」页核验授权码与证件</span>`
            : `<button class="primary big-sign" id="sign-btn" ${canSign ? "" : "disabled"}>
                 签收「${esc(nextSeg ? nextSeg.label : "")}」</button>
               ${canSign ? "" : `<div class="muted" style="margin-top:8px">当前岗位/站点无此环节签收权限(须 ${esc(state.roles[roleFor(nextSeg)] || "")} · ${esc(nextSeg ? nextSeg.station : "")})。</div>`}`}
      </div>
    </div>
    ${exceptionPanelHtml(d)}`;
  const btn = $("#sign-btn");
  if (btn && canSign) {
    btn.onclick = () => modal("签收确认", `
      <p>由 <b>${esc(state.me.name)}</b>(${esc(state.roles[state.me.role])}) 签收
      「<b>${esc(nextSeg.label)}</b>」。签收即写入不可覆盖的交接链。</p>
      ${field("note", "交接备注", "", "text", "如: 证件核验通过")}`,
      async v => {
        await api(`/api/cases/${state.caseId}/sign`, { method: "POST",
          body: { staff_id: state.me.id, note: v.note } });
        toast("签收成功, 交接链已推进");
        viewCaseDetail(state.caseId, "handover");
      }, "确认签收");
  }
  bindExceptionPanel(body, d);
}

const roleFor = seg => ({ COUNTER_TO_GROUND: "ground", GROUND_TO_CREW: "crew",
  CREW_TO_ARRIVAL: "arrival", ARRIVAL_TO_RECEIVER: "arrival" }[seg.key]);

function stationOk(seg) {
  if (state.me.role === "crew") return true;      // 乘务组随机组流动
  return state.me.station === seg.station;
}

/* ----- 异常路径面板(单独列出) ----- */
function exceptionPanelHtml(d) {
  const open = d.exceptions.filter(e => e.status === "OPEN");
  return `
    <div class="card exception-panel">
      <h2>应急路径 · 异常处理</h2>
      <div class="exc-grid">
        <button class="exc-btn" data-exc="delay"><b>航班延误</b><span>通知接机人新预计到达时间</span></button>
        <button class="exc-btn" data-exc="divert"><b>航班改降</b><span>交接链转至备降站继续</span></button>
        <button class="exc-btn" data-exc="receiver"><b>接机人更换</b><span>旧授权码立即失效</span></button>
        <button class="exc-btn" data-exc="unwell"><b>儿童身体不适</b><span>通知家属并联系航医</span></button>
        <button class="exc-btn" data-exc="shift"><b>交接人临时换班</b><span>改派下一责任人</span></button>
        <button class="exc-btn" data-exc="unreachable"><b>联系不上家属</b><span>重试并升级值班主管</span></button>
        <button class="exc-btn" data-exc="doc"><b>证件不一致</b><span>在「到达领取」核验时自动触发</span></button>
      </div>
      <div class="section-gap">
        <h3>进行中的异常 (${open.length})</h3>
        ${open.length === 0 ? '<p class="muted">当前无未处理异常。</p>' : open.map(e => `
          <div class="exc-item">
            <div class="t">${esc(state.exceptionTypes[e.type] || e.type)}</div>
            <div>${esc(e.detail)}</div>
            <div class="meta">${esc(e.created_at)} · 上报: ${esc(e.created_by)}</div>
          </div>`).join("")}
      </div>
    </div>`;
}

function bindExceptionPanel(body, d) {
  const f = d.flight || {};
  body.querySelectorAll("[data-exc]").forEach(btn => {
    btn.onclick = () => {
      const kind = btn.dataset.exc;
      if (kind === "delay") {
        modal("航班延误", field("minutes", "延误分钟数", "45", "number"), async v => {
          await api(`/api/flights/${f.flight_no}/delay`, { method: "POST",
            body: { flight_date: f.flight_date, minutes: Number(v.minutes) } });
          toast("已登记延误并通知接机人");
          viewCaseDetail(state.caseId, "handover");
        });
      } else if (kind === "divert") {
        modal("航班改降(备降)",
          selectField("station", "备降站", [["NKG", "NKG 南京禄口"], ["CAN", "CAN 广州白云"], ["SHA", "SHA 上海虹桥"]]) +
          field("est_arr", "预计到达", "2026-10-02 14:00"),
          async v => {
            await api(`/api/flights/${f.flight_no}/divert`, { method: "POST",
              body: { flight_date: f.flight_date, station: v.station, est_arr: v.est_arr } });
            toast(`已改降 ${v.station}, 交接链将在新站点继续`);
            viewCaseDetail(state.caseId, "handover");
          });
      } else if (kind === "receiver") {
        modal("接机人更换 · 旧授权码立即失效",
          field("name", "新接机人姓名") + field("phone", "手机") +
          field("id_number", "证件号码(虚构)") + field("relation", "与儿童关系") +
          field("reason", "变更原因", "原接机人行程冲突"),
          async v => {
            const r = await api(`/api/cases/${state.caseId}/receiver`, { method: "POST",
              body: { receiver: { name: v.name, phone: v.phone, id_number: v.id_number,
                relation: v.relation }, reason: v.reason, staff_id: state.me.id } });
            toast(`已变更, 新授权码 ${r.new_code}(已短信下发)`);
            viewCaseDetail(state.caseId, "handover");
          });
      } else if (kind === "unwell") {
        modal("儿童身体不适",
          field("detail", "情况说明", "轻微发热, 已测量体温 37.8℃, 精神状态尚可"),
          async v => {
            await api(`/api/cases/${state.caseId}/exceptions`, { method: "POST",
              body: { type: "CHILD_UNWELL", detail: v.detail, staff_id: state.me.id } });
            toast("已记录并通知家属/航医");
            viewCaseDetail(state.caseId, "handover");
          });
      } else if (kind === "shift") {
        const seg = d.segments.find(s => !s.signed);
        const role = seg ? roleFor(seg) : "ground";
        const candidates = state.staff.filter(s => s.role === role && s.id !== state.me.id);
        modal("交接人临时换班",
          selectField("new_staff_id", "改派给", candidates.map(s =>
            [s.id, `${s.name} · ${state.roles[s.role]}${s.station ? " · " + s.station : ""}`])) +
          field("reason", "换班原因", "原责任人班次结束"),
          async v => {
            await api(`/api/cases/${state.caseId}/shift`, { method: "POST",
              body: { new_staff_id: Number(v.new_staff_id), reason: v.reason, staff_id: state.me.id } });
            toast("已改派下一责任人");
            viewCaseDetail(state.caseId, "handover");
          });
      } else if (kind === "unreachable") {
        modal("联系不上家属", "<p>将重试向送机人/接机人发送短信; 仍不可达时自动记录异常并升级值班主管。</p>",
          async () => {
            await api(`/api/cases/${state.caseId}/notify-family`, { method: "POST",
              body: { staff_id: state.me.id } });
            toast("已重试联系家属(见异常通知页)");
            viewCaseDetail(state.caseId, "handover");
          }, "重试联系");
      } else if (kind === "doc") {
        toast("证件不一致在「到达领取」页输入错误证件时自动触发拦截", true);
      }
    };
  });
}

/* ----- 旅客档案(岗位最小可见) ----- */
function tabProfile(body, d) {
  const p = d.profile;
  const rows = [];
  const kv = (k, v) => rows.push(`<dt>${k}</dt><dd>${v}</dd>`);
  kv("儿童代号", `<b>${esc(p.code)}</b>`);
  if (p.child_name) kv("姓名", esc(p.child_name));
  if (p.child_age !== undefined) kv("年龄", p.child_age);
  if (p.child_gender) kv("性别", esc(p.child_gender));
  if (p.doc_type) kv("证件", `${esc(p.doc_type)} · ${esc(p.doc_masked)}`);
  if (p.flight) kv("航班", esc(p.flight));
  if (p.seat) kv("座位", esc(p.seat));
  if (p.care_notes) kv("特殊照顾", esc(p.care_notes));
  if (p.sender) kv("送机人", `${esc(p.sender.name)} · ${esc(p.sender.phone)} · ${esc(p.sender.relation)} · 证件 ${esc(p.sender.id_masked)}`);
  if (p.receiver) kv("接机人", `${esc(p.receiver.name)} · ${esc(p.receiver.phone)} · ${esc(p.receiver.relation)} · 证件 ${esc(p.receiver.id_masked)}`);
  if (p.receiver_masked) kv("接机人", `${esc(p.receiver_masked.name)} · ${esc(p.receiver_masked.phone)} · ${esc(p.receiver_masked.relation)}`);
  body.innerHTML = `
    <div class="card">
      <h2>旅客档案 · 按岗位最小可见(当前: ${esc(state.roles[state.me.role])})</h2>
      <dl class="kv">${rows.join("")}</dl>
      ${p.doc_mask_image ? `<h3 class="section-gap">证件遮罩图(虚构样例)</h3>
        <img class="mask-img" src="/${esc(p.doc_mask_image)}" alt="虚构证件遮罩图">` : ""}
    </div>`;
}

/* ----- 航段时间线 ----- */
function tabTimeline(body, d) {
  const f = d.flight || {};
  const items = [];
  items.push({ t: f.sched_dep, label: `计划起飞 · ${esc(f.origin || "")}`, done: true });
  for (const s of d.segments) {
    items.push({
      t: s.event ? s.event.created_at : "—",
      label: `${esc(s.label)} · ${esc(s.location)}`,
      done: s.signed,
      extra: s.event ? `签收人 ${esc(s.event.signed_by_name)}` : "待签收",
    });
  }
  items.push({
    t: f.est_arr || f.sched_arr,
    label: `${f.status === "DIVERTED" ? "改降后预计到达" : f.status === "DELAYED" ? "延误后预计到达" : "计划到达"} · ${esc(d.arrival_station)}`,
    done: d.status === "COMPLETED",
  });
  body.innerHTML = `
    <div class="card">
      <h2>航段时间线 · 每段明确时间与地点</h2>
      <ul class="timeline">
        ${items.map(i => `
          <li class="${i.done ? "signed" : ""}">
            <div class="tl-label">${i.label}</div>
            <div class="tl-whenwhere">时间 <b>${esc(i.t || "—")}</b>${i.extra ? " · " + i.extra : ""}</div>
          </li>`).join("")}
      </ul>
    </div>`;
}

/* ----- 交接签名 ----- */
function tabSignatures(body, d) {
  body.innerHTML = `
    <div class="card">
      <h2>交接签名 · 不可覆盖的交接链</h2>
      ${d.events.length === 0 ? '<p class="muted">尚无签收记录。</p>' : `
      <table>
        <tr><th>环节</th><th>签收人</th><th>岗位</th><th>站点 / 地点</th><th>时间</th><th>备注</th></tr>
        ${d.events.map(e => `
          <tr>
            <td>${e.seq}. ${esc(e.segment)}</td>
            <td><b>${esc(e.signed_by_name)}</b></td>
            <td>${esc(state.roles[e.signed_by_role] || e.signed_by_role)}</td>
            <td>${esc(e.station)} · ${esc(e.location)}</td>
            <td>${esc(e.created_at)}</td>
            <td>${esc(e.note || "")}</td>
          </tr>`).join("")}
      </table>`}
    </div>`;
}

/* ----- 授权变更 ----- */
function tabAuth(body, d) {
  const canSeeCode = ["counter", "arrival"].includes(state.me.role);
  body.innerHTML = `
    <div class="card">
      <h2>授权码状态 ${canSeeCode ? "" : "(当前岗位不可见明文)"}</h2>
      <table>
        <tr><th>状态</th><th>授权码</th><th>签发对象</th><th>签发时间</th></tr>
        ${d.auth.map(a => `
          <tr>
            <td><span class="chip ${a.status === "ACTIVE" ? "ok" : a.status === "REVOKED" ? "orange" : ""}">${{ ACTIVE: "有效", REVOKED: "已失效", USED: "已使用" }[a.status]}</span></td>
            <td><b>${esc(a.code)}</b></td>
            <td>${esc(a.issued_for)}</td>
            <td>${esc(a.created_at)}</td>
          </tr>`).join("")}
      </table>
    </div>
    <div class="card">
      <h2>授权变更记录</h2>
      ${d.auth_changes.length === 0 ? '<p class="muted">无变更。</p>' : `
      <table>
        <tr><th>原接机人</th><th>新接机人</th><th>原因</th><th>经办</th><th>时间</th></tr>
        ${d.auth_changes.map(c => `
          <tr><td>${esc(c.old_receiver)}</td><td><b>${esc(c.new_receiver)}</b></td>
          <td>${esc(c.reason)}</td><td>${esc(c.operator_name)}</td><td>${esc(c.created_at)}</td></tr>`).join("")}
      </table>`}
    </div>`;
}

/* ----- 异常通知 ----- */
function tabExceptions(body, d) {
  body.innerHTML = `
    <div class="card">
      <h2>异常记录</h2>
      ${d.exceptions.length === 0 ? '<p class="muted">无异常。</p>' : d.exceptions.map(e => `
        <div class="exc-item">
          <div class="t">${esc(state.exceptionTypes[e.type] || e.type)}
            <span class="chip ${e.status === "OPEN" ? "orange" : "ok"}">${e.status === "OPEN" ? "处理中" : "已关闭"}</span></div>
          <div>${esc(e.detail)}</div>
          <div class="meta">${esc(e.created_at)} · 上报: ${esc(e.created_by)}</div>
        </div>`).join("")}
    </div>
    <div class="card">
      <h2>短信通知出站记录(模拟网关)</h2>
      ${d.notifications.length === 0 ? '<p class="muted">暂无通知。</p>' : `
      <table>
        <tr><th>收件人</th><th>号码</th><th>内容</th><th>状态</th><th>时间</th></tr>
        ${d.notifications.map(n => `
          <tr>
            <td>${esc(n.to_name)}</td><td>${esc(n.to_phone)}</td>
            <td>${esc(n.body)}</td>
            <td><span class="chip ${n.status === "SENT" ? "ok" : "orange"}">${n.status === "SENT" ? "已送达" : "发送失败"}</span></td>
            <td>${esc(n.created_at)}</td>
          </tr>`).join("")}
      </table>`}
    </div>`;
}

/* ----- 到达领取 ----- */
function tabPickup(body, d) {
  const ready = d.segments.filter(s => s.signed).length === 3 && d.status !== "COMPLETED";
  const last = d.events[d.events.length - 1];
  body.innerHTML = `
    <div class="card">
      <h2>到达领取 · 核验授权码与证件</h2>
      ${d.status === "COMPLETED"
        ? `<div class="notice">✓ 已由接机人领取。${last ? `签收时间 ${esc(last.created_at)} · ${esc(last.location)}` : ""}</div>`
        : !ready
          ? `<div class="notice">上一环节未签收, 不能进入领取环节(当前完成 ${d.segments.filter(s => s.signed).length}/4 段)。</div>`
          : `<div class="notice">到达站: ${esc(d.arrival_station)} · 请核验接机人本人证件与授权码。证件不一致将自动触发异常并通知送机人。</div>
             <form id="pickup-form" class="grid2">
               ${field("auth_code", "接机授权码(6位)")}
               ${field("doc_number", "接机人证件号码")}
             </form>
             <button class="accent big-sign" id="pickup-btn">核验并完成领取</button>`}
    </div>`;
  const btn = $("#pickup-btn");
  if (btn) {
    btn.onclick = async () => {
      const auth_code = $('#pickup-form [name="auth_code"]').value.trim();
      const doc_number = $('#pickup-form [name="doc_number"]').value.trim();
      try {
        await api(`/api/cases/${state.caseId}/pickup`, { method: "POST",
          body: { auth_code, doc_number, staff_id: state.me.id } });
        toast("核验通过, 儿童已由授权接机人领取");
        viewCaseDetail(state.caseId, "pickup");
      } catch (e) {
        toast(e.message, true);
        viewCaseDetail(state.caseId, "exceptions");
      }
    };
  }
}

/* ----- 航班运行 ----- */
async function viewOps() {
  navActive("ops");
  const { flights } = await api("/api/flights");
  app.innerHTML = `
    <div class="card">
      <h2>航班运行(模拟适配器)</h2>
      <table>
        <tr><th>航班</th><th>日期</th><th>航线</th><th>计划</th><th>状态</th><th>操作</th></tr>
        ${flights.map(f => `
          <tr>
            <td><b>${esc(f.flight_no)}</b></td><td>${esc(f.flight_date)}</td>
            <td>${esc(f.origin)} → ${f.status === "DIVERTED" ? esc(f.diverted_to) + "(改降)" : esc(f.destination)}</td>
            <td>${esc(f.sched_dep)} — ${esc(f.est_arr || f.sched_arr)}</td>
            <td><span class="chip ${f.status === "SCHEDULED" ? "" : "orange"}">${{ SCHEDULED: "正常", DELAYED: "延误", DIVERTED: "改降", ARRIVED: "到达" }[f.status]}</span></td>
            <td>
              <button data-op="delay" data-f="${esc(f.flight_no)}" data-d="${esc(f.flight_date)}">延误</button>
              <button data-op="divert" data-f="${esc(f.flight_no)}" data-d="${esc(f.flight_date)}">改降</button>
            </td>
          </tr>`).join("")}
      </table>
      <p class="muted">延误/改降会自动为在途儿童案例生成异常记录并短信通知家属(模拟)。</p>
    </div>`;
  app.querySelectorAll("[data-op]").forEach(btn => {
    btn.onclick = () => {
      const f = btn.dataset.f, date = btn.dataset.d;
      if (btn.dataset.op === "delay") {
        modal(`航班 ${f} 延误`, field("minutes", "延误分钟数", "45", "number"), async v => {
          await api(`/api/flights/${f}/delay`, { method: "POST",
            body: { flight_date: date, minutes: Number(v.minutes) } });
          toast("已登记延误并通知家属");
          viewOps();
        });
      } else {
        modal(`航班 ${f} 改降`,
          selectField("station", "备降站", [["NKG", "NKG 南京禄口"], ["CAN", "CAN 广州白云"], ["SHA", "SHA 上海虹桥"]]) +
          field("est_arr", "预计到达", "2026-10-02 14:00"),
          async v => {
            await api(`/api/flights/${f}/divert`, { method: "POST",
              body: { flight_date: date, station: v.station, est_arr: v.est_arr } });
            toast(`已改降 ${v.station}`);
            viewOps();
          });
      }
    };
  });
}

boot().catch(e => { app.innerHTML = `<div class="card"><p>启动失败: ${esc(e.message)}</p></div>`; });
