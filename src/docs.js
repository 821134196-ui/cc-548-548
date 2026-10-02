'use strict';
// 虚构证件遮罩图：本地生成 SVG（非真实证件、非真实人像）。
// 画面上对证件号做打码条处理，仅留前后各 2-3 位用于人工核对。
const fs = require('node:fs');
const path = require('node:path');
const { maskId } = require('./util');

function renderDocSvg({ kind, name, idNumber, seat, flightNo }) {
  const title = kind === 'ESCORT_ID' ? '送机人身份凭证（模拟·遮罩）' : '接机人授权凭证（模拟·遮罩）';
  const color = kind === 'ESCORT_ID' ? '#0B2A4A' : '#1E4D8C';
  const masked = maskId(idNumber);
  // 固定形状、无外部资源的占位"照片"
  return `<svg xmlns="http://www.w3.org/2000/svg" width="520" height="320" viewBox="0 0 520 320" font-family="sans-serif">
  <rect width="520" height="320" fill="#FFFFFF" stroke="${color}" stroke-width="4"/>
  <rect width="520" height="56" fill="${color}"/>
  <text x="20" y="36" fill="#FFFFFF" font-size="20" font-weight="bold">${title}</text>
  <rect x="24" y="80" width="96" height="104" rx="6" fill="#E8EEF5" stroke="#9FB4CC"/>
  <circle cx="72" cy="118" r="24" fill="#9FB4CC"/>
  <path d="M34 176 Q72 138 110 176 Z" fill="#9FB4CC"/>
  <text x="140" y="104" font-size="18" fill="#0B2A4A">姓名：${name}</text>
  <text x="140" y="140" font-size="16" fill="#33475C">证件号：</text>
  <g>
    <rect x="210" y="126" width="150" height="20" fill="#0B2A4A"/>
    <text x="210" y="142" font-size="15" fill="#E8722B" font-weight="bold">${masked}</text>
  </g>
  <text x="140" y="176" font-size="15" fill="#33475C">关联航班：${flightNo}　座位：${seat}</text>
  <rect x="24" y="210" width="472" height="72" rx="6" fill="#F5F8FC" stroke="#C7D5E6"/>
  <text x="36" y="236" font-size="14" fill="#8A5A12">本凭证为演练用虚构信息，号码与人员均不对应真实身份；</text>
  <text x="36" y="258" font-size="14" fill="#8A5A12">黑色打码条外的少量字符仅供"柜台核验/到达领取"当面比对。</text>
  <text x="36" y="300" font-size="12" fill="#7A8797">UMNR HANDOFF · MOCK DOCUMENT · NOT VAL ID</text>
</svg>`;
}

function writeMaskedDoc(dir, { kind, name, idNumber, seat, flightNo }) {
  fs.mkdirSync(dir, { recursive: true });
  const file = `${kind}_${name}_${flightNo}.svg`.replace(/[^\w.\-一-龥]/g, '_');
  const filePath = path.join(dir, file);
  fs.writeFileSync(filePath, renderDocSvg({ kind, name, idNumber, seat, flightNo }), 'utf8');
  return filePath;
}

module.exports = { renderDocSvg, writeMaskedDoc };
