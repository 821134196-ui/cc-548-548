'use strict';
// 服务端渲染：交接页（大字）、航段时间线、六类交付、异常路径专区。
// 配色：航空白 #FFFFFF/#F5F8FC、深蓝 #0B2A4A/#1E4D8C、高对比橙 #E8722B。
const { esc, fmtTime, EX_TYPES, FIELD_LABELS, STAGES } = require('./util');

const CSS = `
:root{--navy:#0B2A4A;--blue:#1E4D8C;--orange:#E8722B;--bg:#F5F8FC;--line:#C7D5E6;--ink:#1B2A3A;--muted:#5C6E80;--ok:#1B7A43;--warnbg:#FFF3EA;}
*{box-sizing:border-box}
body{margin:0;font-family:"PingFang SC","Microsoft YaHei",system-ui,sans-serif;background:var(--bg);color:var(--ink);}
a{color:var(--blue)}
header.top{background:var(--navy);color:#fff;padding:14px 28px;display:flex;align-items:center;gap:18px;flex-wrap:wrap}
header.top .brand{font-size:20px;font-weight:800;letter-spacing:1px}
header.top a{color:#cfe0f5;text-decoration:none;font-size:14px}
.wrap{max-width:1180px;margin:0 auto;padding:22px}
.hero{background:#fff;border:3px solid var(--navy);border-radius:14px;padding:26px 30px;margin-bottom:18px;box-shadow:0 2px 10px rgba(11,42,74,.08)}
.hero .code{font-size:46px;font-weight:900;color:var(--navy);line-height:1.1}
.hero .flight{font-size:30px;font-weight:800;color:var(--blue);margin-top:6px}
.hero .flight .seat{color:var(--orange)}
.hero .next{margin-top:14px;font-size:26px;font-weight:800;color:var(--orange)}
.hero .next .place{color:var(--navy)}
.hero .meta{margin-top:12px;color:var(--muted);font-size:15px}
.badge{display:inline-block;padding:2px 10px;border-radius:999px;font-size:13px;font-weight:700;margin-left:8px}
.badge.open{background:#E3EDF8;color:var(--blue)}
.badge.chain{background:#FFF0E2;color:#B45312}
.badge.done{background:#E2F4E9;color:var(--ok)}
.badge.div{background:#FDE4D3;color:#B45312}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:18px}
@media(max-width:900px){.grid{grid-template-columns:1fr}}
.card{background:#fff;border:1px solid var(--line);border-radius:12px;padding:18px 20px;margin-bottom:18px}
.card h2{margin:0 0 12px;font-size:19px;color:var(--navy);border-left:6px solid var(--orange);padding-left:10px}
.card h3{margin:14px 0 8px;font-size:16px;color:var(--blue)}
.steps{display:flex;flex-direction:column;gap:0}
.step{display:grid;grid-template-columns:44px 1fr auto;gap:12px;align-items:start;padding:14px 6px;border-left:4px solid var(--line);margin-left:16px;padding-left:18px;position:relative}
.step::before{content:"";position:absolute;left:-11px;top:20px;width:18px;height:18px;border-radius:50%;background:#fff;border:4px solid var(--line)}
.step.signed{border-left-color:var(--ok)}
.step.signed::before{border-color:var(--ok);background:var(--ok)}
.step.now{border-left-color:var(--orange)}
.step.now::before{border-color:var(--orange);box-shadow:0 0 0 5px #FDE4D3}
.step .n{font-weight:800;color:var(--muted)}
.step .name{font-weight:800;font-size:17px;color:var(--navy)}
.step .sub{color:var(--muted);font-size:14px;margin-top:3px}
.step .when{text-align:right;font-size:13px;color:var(--muted);white-space:nowrap}
.step .when b{display:block;color:var(--ok);font-size:14px}
.step .nowtag{color:var(--orange);font-weight:800}
table{width:100%;border-collapse:collapse;font-size:14px}
th,td{border-bottom:1px solid var(--line);padding:8px 10px;text-align:left;vertical-align:top}
th{background:var(--bg);color:var(--navy);font-weight:700}
.tag{padding:1px 8px;border-radius:6px;font-size:12px;font-weight:700}
.tag.ACTIVE{background:#E2F4E9;color:var(--ok)}
.tag.REVOKED{background:#F0E2E2;color:#9A2B2B;text-decoration:line-through}
.tag.USED{background:#E3EDF8;color:var(--blue)}
.tag.UNRESOLVED{background:var(--warnbg);color:#B45312}
.tag.RESOLVED{background:#E2F4E9;color:var(--ok)}
.btn{display:inline-block;border:0;border-radius:8px;padding:10px 18px;font-size:15px;font-weight:800;cursor:pointer;text-decoration:none}
.btn-navy{background:var(--navy);color:#fff}
.btn-blue{background:var(--blue);color:#fff}
.btn-orange{background:var(--orange);color:#fff}
.btn-ghost{background:#fff;color:var(--blue);border:1.5px solid var(--blue)}
.btn:disabled{opacity:.5;cursor:not-allowed}
input,select,textarea{font:inherit;padding:8px 10px;border:1.5px solid var(--line);border-radius:8px;width:100%;margin:4px 0 10px}
label{font-size:13px;font-weight:700;color:var(--navy)}
.row2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.flash{padding:12px 16px;border-radius:10px;margin-bottom:14px;font-weight:700}
.flash.err{background:#F9E4E2;color:#8E231C;border:1px solid #E2B6B1}
.flash.ok{background:#E2F4E9;color:var(--ok);border:1px solid #B8E0C8}
.exception-box{border:2px solid var(--orange);background:var(--warnbg);border-radius:12px}
.exception-box h2{border-left-color:var(--orange)}
.ex-path{border:1px solid #F2C9A8;background:#fff;border-radius:10px;padding:10px 14px;margin:8px 0}
.ex-path .t{font-weight:800;color:#B45312}
.ex-path .r{color:var(--muted);font-size:13px;margin:4px 0 8px}
.hidden-note{font-size:12px;color:#9A2B2B;background:#F7ECEC;padding:6px 10px;border-radius:6px;margin-top:8px}
.kv{display:grid;grid-template-columns:130px 1fr;gap:4px 12px;font-size:15px}
.kv dt{color:var(--muted)}
.kv dd{margin:0;font-weight:600}
.sms{background:var(--bg);border-left:4px solid var(--blue);padding:8px 12px;margin:8px 0;font-size:14px;border-radius:0 8px 8px 0}
.hash{font-family:monospace;font-size:11px;color:#8093A6;word-break:break-all}
.pagerole{background:rgba(255,255,255,.12);border-radius:8px;padding:6px 12px;font-size:14px}
.pagerole select{width:auto;margin:0;display:inline-block;padding:4px 8px}
.small{font-size:13px;color:var(--muted)}
.case-list a{display:block;background:#fff;border:1px solid var(--line);border-radius:12px;padding:18px 22px;margin-bottom:12px;text-decoration:none;color:var(--ink);font-size:20px;font-weight:800}
.case-list a:hover{border-color:var(--blue)}
.docframe{width:100%;height:340px;border:1px solid var(--line);border-radius:8px;background:#fff}
.done-banner{background:var(--navy);color:#fff;border-radius:12px;padding:18px 22px;font-size:22px;font-weight:900;text-align:center;margin-bottom:18px}
`;

function layout({ title, body, staffOptions = '', currentStaffId = '', flash = '', staffFormExtra = '' }) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · UMNR 交接链</title><style>${CSS}</style></head><body>
<header class="top">
  <div class="brand">✈ UMNR 无成人陪伴儿童交接链（模拟）</div>
  <a href="/?staff=${encodeURIComponent(currentStaffId || '')}">交接台</a>
  <div class="pagerole">当前登录视角：
    <form method="get" id="roleForm" style="display:inline">${staffFormExtra}
      <select name="staff" onchange="this.form.submit()">${staffOptions}</select>
      <noscript><button class="btn btn-orange" type="submit">切换</button></noscript>
    </form>
  </div>
</header>
<div class="wrap">${flash}${body}</div></body></html>`;
}

function staffOptionsHtml(staffList, currentId) {
  return staffList.map((s) =>
    `<option value="${esc(s.id)}" ${s.id === currentId ? 'selected' : ''}>${esc(s.name)}｜${roleName(s.role)}｜${esc(s.station_code)}</option>`
  ).join('');
}
function roleName(r) {
  return { checkin: '值机柜台', ground: '地面人员', crew: '乘务组', station: '到达站接待' }[r] || r;
}

function statusBadge(reg, flight) {
  if (reg.status === 'COMPLETED') return '<span class="badge done">已闭环领取</span>';
  if (flight.status === 'DIVERTED') return '<span class="badge div">已改降 ' + esc(flight.divertedTo) + '</span>';
  if (reg.status === 'IN_CHAIN') return '<span class="badge chain">交接进行中</span>';
  return '<span class="badge open">待柜台签发</span>';
}

module.exports = { layout, staffOptionsHtml, roleName, statusBadge, CSS, esc, fmtTime };
