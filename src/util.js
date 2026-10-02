'use strict';
// 通用工具：时间、编号、遮罩、岗位权限矩阵。

const STAGES = Object.freeze([
  { key: 'CHECKIN', name: '值机柜台交接', actor: 'checkin', place: '出发站值机柜台', next: 'GROUND_DEP' },
  { key: 'GROUND_DEP', name: '地面人员接收', actor: 'ground', place: '出发站登机口', next: 'CREW' },
  { key: 'CREW', name: '乘务组接收', actor: 'crew', place: '客舱舱门', next: 'GROUND_ARR' },
  { key: 'GROUND_ARR', name: '到达站地面接收', actor: 'ground', place: '到达站登机口', next: 'PICKUP' },
  { key: 'PICKUP', name: '授权接机人领取', actor: 'station', place: '到达站到达厅接待处', next: null },
]);
const STAGE_KEYS = STAGES.map((s) => s.key);
const STAGE_BY_KEY = Object.fromEntries(STAGES.map((s) => [s.key, s]));

// 六类异常
const EX_TYPES = Object.freeze({
  DELAY: '航班延误',
  DIVERT: '航班改降',
  PICKUP_CHANGE: '接机人更换',
  ID_MISMATCH: '证件不一致',
  CHILD_UNWELL: '儿童身体不适',
  SHIFT_CHANGE: '交接人临时换班',
  FAMILY_UNREACHABLE: '联系不上家属',
});

// 岗位 -> 可见的儿童档案字段（最小可见原则）
const FIELD_VISIBILITY = Object.freeze({
  checkin: ['codeName', 'flightNo', 'seat', 'ageBand', 'from', 'to', 'escortName', 'escortIdMasked', 'escortPhoneMasked', 'specialCare', 'pickupName', 'pickupIdMasked'],
  ground: ['codeName', 'flightNo', 'seat', 'ageBand', 'from', 'to', 'specialCare', 'medNotes', 'pickupName'],
  crew: ['codeName', 'flightNo', 'seat', 'ageBand', 'specialCare', 'medNotes'],
  station: ['codeName', 'flightNo', 'seat', 'ageBand', 'to', 'specialCare', 'medNotes', 'pickupName', 'pickupIdMasked', 'pickupPhoneMasked'],
});
// 接机人本人在领取环节额外看到自己的联系方式
const SELF_PICKUP_EXTRA = ['pickupPhoneMasked'];

const FIELD_LABELS = Object.freeze({
  codeName: '儿童代号', flightNo: '航班号', seat: '座位', ageBand: '年龄段',
  from: '出发站', to: '到达站', specialCare: '特殊照顾说明', medNotes: '随行健康提示',
  escortName: '送机人', escortIdMasked: '送机人证件', escortPhoneMasked: '送机人电话',
  pickupName: '接机人', pickupIdMasked: '接机人证件', pickupPhoneMasked: '接机人电话',
});

function nowIso() { return new Date().toISOString(); }

let counter = 0;
function genId(prefix) {
  counter = (counter + 1) % 1000;
  const t = process.hrtime.bigint().toString(36);
  return `${prefix}_${t}${counter.toString(36).padStart(2, '0')}`;
}

function genAuthCode() {
  // 6 位大写易辨认字符（去掉易混淆字符）
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let s = '';
  const b = require('node:crypto').randomBytes(6);
  for (const x of b) s += alphabet[x % alphabet.length];
  return s;
}

function maskId(id) {
  if (!id) return '';
  // 送机/接机人证件本就是虚构号；存储时同时保留明文（柜台核验需要），展示一律遮罩
  const head = id.slice(0, 3);
  const tail = id.slice(-2);
  return `${head}********${tail}`;
}
function maskPhone(p) {
  if (!p) return '';
  return p.replace(/^(\d{3})\d{4}(\d{4})$/, '$1****$2');
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

module.exports = {
  STAGES, STAGE_KEYS, STAGE_BY_KEY, EX_TYPES,
  FIELD_VISIBILITY, SELF_PICKUP_EXTRA, FIELD_LABELS,
  nowIso, genId, genAuthCode, maskId, maskPhone, esc, fmtTime,
};
