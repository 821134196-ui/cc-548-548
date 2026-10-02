'use strict';
// 零依赖 HTTP 服务：页面路由 + 签收/异常/授权变更动作。
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');
const { layout, staffOptionsHtml, esc } = require('./render');
const { renderCasePage } = require('./views');
const { DomainError } = require('./service');
const { EX_TYPES } = require('./util');

function createServer(ctx) {
  const { db, service, flightAdapter } = ctx;

  function staffList() {
    return db.prepare('SELECT * FROM staff WHERE active=1 ORDER BY role, station_code').all();
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let data = '';
      req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
      req.on('end', () => resolve(new URLSearchParams(data)));
      req.on('error', reject);
    });
  }

  function page(title, body, staffId, flash, regId = null) {
    return layout({
      title, body, currentStaffId: staffId || '',
      staffOptions: staffOptionsHtml(staffList(), staffId),
      staffFormExtra: regId ? `<input type="hidden" name="reg" value="${esc(regId)}">` : '',
      flash,
    });
  }

  function redirect(res, location) { res.writeHead(303, { location }); res.end(); }

  function caseListHtml(staffId = '') {
    const rows = db.prepare(`SELECT r.id reg_id, r.status, r.handoff_form_no, c.code_name,
      f.flight_no, f.from_code, f.to_code, f.status fstatus, f.diverted_to
      FROM registrations r JOIN children c ON c.id=r.child_id JOIN flights f ON f.id=r.flight_id
      ORDER BY r.created_at`).all();
    const suffix = staffId ? `&staff=${encodeURIComponent(staffId)}` : '';
    const items = rows.map((r) => `<a href="/case?reg=${encodeURIComponent(r.reg_id)}${suffix}">
      ${esc(r.code_name)}　<span class="small">${esc(r.flight_no)} ${esc(r.from_code)}→${r.diverted_to ? esc(r.diverted_to) + '（改降）' : esc(r.to_code)}｜${esc(r.handoff_form_no)}</span></a>`).join('');
    return `<div class="card"><h2>在途交接单</h2><div class="case-list">${items}</div>
    <p class="small">演示建议：先打开「小海豚」用 <b>王值机(PEK)</b> 视角完成柜台签发，逐段切换视角签收；
    「小熊猫」已内置改降 SZX 与接机授权 v1→v2（旧码失效）样例。</p></div>`;
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      const p = url.pathname;
      const staffId = url.searchParams.get('staff') || '';
      const flash = url.searchParams.get('ok')
        ? `<div class="flash ok">${esc(url.searchParams.get('ok'))}</div>`
        : url.searchParams.get('err')
          ? `<div class="flash err">${esc(url.searchParams.get('err'))}</div>` : '';

      if (p === '/' && req.method === 'GET') {
        res.end(page('交接台', caseListHtml(staffId), staffId, flash));
        return;
      }

      if (p === '/case' && req.method === 'GET') {
        const regId = url.searchParams.get('reg');
        const body = renderCasePage(ctx, regId, staffId);
        res.end(page(`交接单 ${regId}`, body, staffId, flash, regId));
        return;
      }

      // 遮罩证件：只提供数据库登记过的本地遮罩图，且仅允许 .svg
      if (p.startsWith('/doc/') && req.method === 'GET') {
        const id = p.slice(5);
        const doc = db.prepare('SELECT * FROM masked_docs WHERE id=?').get(id);
        if (!doc) { res.writeHead(404); res.end('not found'); return; }
        const fp = path.resolve(doc.file_path);
        if (!fp.endsWith('.svg') || path.basename(fp).includes('..')) { res.writeHead(403); res.end('forbidden'); return; }
        if (!fs.existsSync(fp)) { res.writeHead(410); res.end('doc missing'); return; }
        res.writeHead(200, { 'content-type': 'image/svg+xml; charset=utf-8' });
        fs.createReadStream(fp).pipe(res);
        return;
      }

      if (req.method === 'POST') {
        const body = await readBody(req);
        const reg = body.get('reg');
        const asStaff = body.get('staff') || '';
        const back = (ok, err) => redirect(res,
          `/case?reg=${encodeURIComponent(reg)}&staff=${encodeURIComponent(asStaff)}`
          + (ok ? `&ok=${encodeURIComponent(ok)}` : `&err=${encodeURIComponent(err)}`));
        try {
          if (p === '/checkin') {
            service.checkinIssue({
              regId: reg, checkinStaffId: asStaff, groundStaffId: body.get('groundStaffId'),
              escortIdNumber: body.get('escortIdNumber').trim(),
            });
            return back('送机人身份核验通过，交接单已签发，地面人员可签收');
          }
          if (p === '/sign') {
            service.signStage({
              regId: reg, stageKey: body.get('stage'), staffId: asStaff,
              note: body.get('note') || '',
            });
            return back('本段签收成功，已写入不可覆盖交接链');
          }
          if (p === '/pickup') {
            service.signStage({
              regId: reg, stageKey: 'PICKUP', staffId: asStaff,
              toPersonId: body.get('toPersonId'),
              authCode: body.get('authCode').trim().toUpperCase(),
              pickupIdNumber: body.get('pickupIdNumber').trim(),
            });
            return back('授权码与证件双验通过，儿童已交付，交接链闭环');
          }
          if (p === '/change-pickup') {
            const r = service.changePickup({
              regId: reg, staffId: asStaff, newPersonId: body.get('newPersonId'),
              reason: body.get('reason') || '家属申请更换',
            });
            return back(`授权已变更为 v${r.version}（提示 ${r.hint}）；旧码立即失效，新码模拟短信已发出`);
          }
          if (p === '/exception') {
            const type = body.get('type');
            const detail = body.get('detail') || EX_TYPES[type];
            service.raiseException({ regId: reg, type, staffId: asStaff, detail });
            return back(`异常「${EX_TYPES[type]}」已登记，应急路径已列入专区`);
          }
          if (p === '/resolve') {
            service.resolveException({
              exceptionId: body.get('exId'), staffId: asStaff,
              summary: body.get('summary') || '现场处置完成',
            });
            return back('处置已闭环并留痕');
          }
          if (p === '/poll') {
            const f = service.pollFlightUpdate(reg, asStaff || 'SYSTEM');
            return back(`航班动态已拉取：${f.status}${f.diverted_to ? ' → ' + f.diverted_to : ''}`);
          }
          if (p === '/sim-delay') {
            const flight = db.prepare('SELECT * FROM flights WHERE id=(SELECT flight_id FROM registrations WHERE id=?)').get(reg);
            flightAdapter._inject(flight.flight_no, {
              status: 'DELAYED', depEstimate: '2026-10-02T11:10:00+08:00', reason: '目的地机场流控（模拟）',
            });
            service.pollFlightUpdate(reg, asStaff || 'SYSTEM');
            return back('模拟适配器已推送「航班延误」，异常与家属通知已生成');
          }
          if (p === '/sim-divert') {
            const flight = db.prepare('SELECT * FROM flights WHERE id=(SELECT flight_id FROM registrations WHERE id=?)').get(reg);
            const to = (body.get('divertedTo') || 'HGH').trim().toUpperCase();
            flightAdapter._inject(flight.flight_no, { status: 'DIVERTED', divertedTo: to, reason: '天气（模拟）' });
            service.pollFlightUpdate(reg, asStaff || 'SYSTEM');
            return back(`模拟适配器已推送「改降 ${to}」，后续交接段自动切换至 ${to} 站`);
          }
        } catch (e) {
          if (e instanceof DomainError) return back(null, `被规则拒绝（${e.code}）：${e.message}`);
          throw e;
        }
      }

      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('404');
    } catch (e) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('服务器错误：' + (e && e.stack ? e.stack : String(e)));
    }
  });
  return server;
}

module.exports = { createServer };
