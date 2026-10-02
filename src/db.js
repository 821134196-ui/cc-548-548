'use strict';
// SQLite 持久层。交接记录为 append-only：触发器禁止 UPDATE/DELETE，
// 链顺序由 stage_seq 唯一约束与 prev_event_id 哈希链共同保证，不可覆盖、不可跳段。
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA = `
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

-- 工作人员（岗位/所属站）
CREATE TABLE IF NOT EXISTS staff (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('checkin','ground','crew','station')),
  station_code TEXT NOT NULL,    -- 站点码，如 PEK / SZX
  shift_no TEXT,                   -- 班次
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

-- 送机人 / 接机人（虚构人员）
CREATE TABLE IF NOT EXISTS persons (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  id_number TEXT NOT NULL,        -- 证件明文仅柜台核验环节使用
  phone TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- 旅客档案
CREATE TABLE IF NOT EXISTS children (
  id TEXT PRIMARY KEY,
  code_name TEXT NOT NULL UNIQUE,         -- 儿童代号（界面大字显示）
  real_name_token TEXT NOT NULL,          -- 真名令牌：仅值机柜台可见，其他岗位拿不到
  age_band TEXT NOT NULL,
  special_care TEXT NOT NULL,
  med_notes TEXT,
  created_at TEXT NOT NULL
);

-- 航段
CREATE TABLE IF NOT EXISTS flights (
  id TEXT PRIMARY KEY,
  child_id TEXT NOT NULL REFERENCES children(id),
  flight_no TEXT NOT NULL,
  seat TEXT NOT NULL,
  from_code TEXT NOT NULL,
  to_code TEXT NOT NULL,
  sched_dep TEXT NOT NULL,
  sched_arr TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'SCHEDULED'
    CHECK(status IN ('SCHEDULED','DELAYED','DEPARTED','DIVERTED','ARRIVED')),
  diverted_to TEXT,                       -- 改降后实际到达站
  created_at TEXT NOT NULL
);

-- 登记（一名儿童 + 一个航段 + 送机人）
CREATE TABLE IF NOT EXISTS registrations (
  id TEXT PRIMARY KEY,
  child_id TEXT NOT NULL REFERENCES children(id),
  flight_id TEXT NOT NULL REFERENCES flights(id),
  escort_id TEXT NOT NULL REFERENCES persons(id),
  handoff_form_no TEXT NOT NULL UNIQUE,   -- 交接单编号
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','IN_CHAIN','COMPLETED','EXCEPTION_HOLD')),
  created_at TEXT NOT NULL
);

-- 接机授权：版本化。授权变更 -> 旧版本 revoked_at 置位（旧码立即失效），新版本新码。
CREATE TABLE IF NOT EXISTS pickup_authorizations (
  id TEXT PRIMARY KEY,
  registration_id TEXT NOT NULL REFERENCES registrations(id),
  version INTEGER NOT NULL,
  person_id TEXT NOT NULL REFERENCES persons(id),
  auth_code_hash TEXT NOT NULL,            -- 只存哈希
  auth_code_hint TEXT NOT NULL,            -- 展示提示（如 AB3***）
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','REVOKED','USED')),
  issued_at TEXT NOT NULL,
  revoked_at TEXT,
  revoke_reason TEXT,
  UNIQUE(registration_id, version)
);

-- append-only 交接链
CREATE TABLE IF NOT EXISTS handoff_events (
  id TEXT PRIMARY KEY,
  registration_id TEXT NOT NULL REFERENCES registrations(id),
  stage_seq INTEGER NOT NULL,              -- 0..4，顺序固定
  stage_key TEXT NOT NULL,
  flight_id TEXT NOT NULL REFERENCES flights(id),
  station_code TEXT NOT NULL,              -- 事件发生站
  from_staff_id TEXT REFERENCES staff(id), -- 交出人（PICKUP 段为到达站地面）
  to_staff_id TEXT REFERENCES staff(id),   -- 接收人（CHECKIN 为柜台签发；PICKUP 为接机人时可空）
  to_person_id TEXT REFERENCES persons(id),-- 仅 PICKUP 段：接机人
  agent_staff_id TEXT REFERENCES staff(id),-- 监交/经办人（PICKUP 为到达站接待员）
  auth_version INTEGER,                    -- 仅 PICKUP 段：使用的授权版本
  result TEXT NOT NULL CHECK(result IN ('SIGNED','REJECTED')),
  note TEXT,
  created_at TEXT NOT NULL,
  prev_hash TEXT,                          -- 哈希链
  self_hash TEXT NOT NULL
);
-- 每段只允许一条"已签收"有效记录（REJECTED 可多条）；并发下第二名签收者被唯一索引拒绝。
CREATE UNIQUE INDEX IF NOT EXISTS uq_signed_stage
  ON handoff_events(registration_id, stage_seq) WHERE result = 'SIGNED';

-- 异常事件（append-only）
CREATE TABLE IF NOT EXISTS exception_events (
  id TEXT PRIMARY KEY,
  registration_id TEXT NOT NULL REFERENCES registrations(id),
  flight_id TEXT REFERENCES flights(id),
  type TEXT NOT NULL CHECK(type IN ('DELAY','DIVERT','PICKUP_CHANGE','ID_MISMATCH','CHILD_UNWELL','SHIFT_CHANGE','FAMILY_UNREACHABLE')),
  station_code TEXT NOT NULL,
  raised_by TEXT NOT NULL,                 -- staff id 或 'SYSTEM'
  detail TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- 异常处置动作（append-only）：应急路径说明 / 解决闭环
CREATE TABLE IF NOT EXISTS exception_actions (
  id TEXT PRIMARY KEY,
  exception_id TEXT NOT NULL REFERENCES exception_events(id),
  kind TEXT NOT NULL CHECK(kind IN ('RESPONSE','RESOLVE')),
  actor TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- 短信发送记录（模拟适配器写出，append-only）
CREATE TABLE IF NOT EXISTS sms_messages (
  id TEXT PRIMARY KEY,
  registration_id TEXT REFERENCES registrations(id),
  to_phone_masked TEXT NOT NULL,
  template TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- 交接单附件：虚构证件遮罩图（只存遮罩图路径，不存原件）
CREATE TABLE IF NOT EXISTS masked_docs (
  id TEXT PRIMARY KEY,
  registration_id TEXT NOT NULL REFERENCES registrations(id),
  person_id TEXT NOT NULL REFERENCES persons(id),
  doc_kind TEXT NOT NULL,                  -- ESCORT_ID / PICKUP_ID
  file_path TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- 防改写：交接链与异常表只允许 INSERT
CREATE TRIGGER IF NOT EXISTS trg_handoff_no_update BEFORE UPDATE ON handoff_events
BEGIN SELECT RAISE(ABORT, 'handoff_events 为不可覆盖交接链，禁止 UPDATE'); END;
CREATE TRIGGER IF NOT EXISTS trg_handoff_no_delete BEFORE DELETE ON handoff_events
BEGIN SELECT RAISE(ABORT, 'handoff_events 为不可覆盖交接链，禁止 DELETE'); END;
CREATE TRIGGER IF NOT EXISTS trg_exception_no_update BEFORE UPDATE ON exception_events
BEGIN SELECT RAISE(ABORT, 'exception_events 不可修改'); END;
CREATE TRIGGER IF NOT EXISTS trg_sms_no_update BEFORE UPDATE ON sms_messages
BEGIN SELECT RAISE(ABORT, 'sms_messages 不可修改'); END;

CREATE INDEX IF NOT EXISTS idx_events_reg ON handoff_events(registration_id, stage_seq);
CREATE INDEX IF NOT EXISTS idx_exc_reg ON exception_events(registration_id, created_at);
CREATE INDEX IF NOT EXISTS idx_auth_reg ON pickup_authorizations(registration_id, version);
`;

function openDb(file, { busyTimeoutMs = 4000 } = {}) {
  if (file !== ':memory:') {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA busy_timeout=${busyTimeoutMs};`);
  db.exec(SCHEMA);
  return db;
}

module.exports = { openDb };
