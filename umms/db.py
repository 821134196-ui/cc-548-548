"""SQLite 存储层。

关键约束:
- handover_events / auth_changes / notifications 为「只增不改」的交接链与事件表,
  通过触发器禁止 UPDATE / DELETE,保证交接链不可覆盖。
- handover_events 上 (case_id, seq) 唯一约束 + 事务内状态检查,
  保证两名工作人员同时交接时只有一条有效记录。
"""
import sqlite3
import threading

SCHEMA = """
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS staff (
  id        INTEGER PRIMARY KEY,
  name      TEXT NOT NULL,
  role      TEXT NOT NULL CHECK (role IN ('counter','ground','crew','arrival')),
  station   TEXT,                 -- 乘务组为 NULL(随机组流动,不受站点限制)
  on_duty   INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS flights (
  flight_no   TEXT NOT NULL,
  flight_date TEXT NOT NULL,
  origin      TEXT NOT NULL,
  destination TEXT NOT NULL,
  sched_dep   TEXT NOT NULL,
  sched_arr   TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'SCHEDULED',  -- SCHEDULED/DELAYED/DIVERTED/ARRIVED
  diverted_to TEXT,
  est_arr     TEXT,
  PRIMARY KEY (flight_no, flight_date)
);

CREATE TABLE IF NOT EXISTS cases (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  code               TEXT NOT NULL UNIQUE,        -- 儿童代号, 如 UM-7F3A
  child_name         TEXT NOT NULL,
  child_age          INTEGER NOT NULL,
  child_gender       TEXT NOT NULL,
  doc_type           TEXT NOT NULL,
  doc_number         TEXT NOT NULL,               -- 虚构证件号, 展示时一律遮罩
  doc_mask_image     TEXT,
  care_notes         TEXT,
  sender_name        TEXT NOT NULL,               -- 送机人
  sender_phone       TEXT NOT NULL,
  sender_id_number   TEXT NOT NULL,
  sender_relation    TEXT NOT NULL,
  receiver_name      TEXT NOT NULL,               -- 当前授权接机人
  receiver_phone     TEXT NOT NULL,
  receiver_id_number TEXT NOT NULL,
  receiver_relation  TEXT NOT NULL,
  flight_no          TEXT NOT NULL,
  flight_date        TEXT NOT NULL,
  seat               TEXT NOT NULL,
  origin             TEXT NOT NULL,
  arrival_station    TEXT NOT NULL,               -- 改降时随之变更
  status             TEXT NOT NULL DEFAULT 'OPEN',-- OPEN/IN_TRANSIT/COMPLETED
  created_at         TEXT NOT NULL
);

-- 交接链: 只增不改
CREATE TABLE IF NOT EXISTS handover_events (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id        INTEGER NOT NULL REFERENCES cases(id),
  seq            INTEGER NOT NULL,                -- 环节序号 1..4
  segment        TEXT NOT NULL,
  station        TEXT NOT NULL,
  location       TEXT NOT NULL,
  from_label     TEXT NOT NULL,
  to_label       TEXT NOT NULL,
  staff_id       INTEGER,
  signed_by_name TEXT NOT NULL,
  signed_by_role TEXT NOT NULL,
  note           TEXT,
  created_at     TEXT NOT NULL,
  UNIQUE (case_id, seq)                           -- 同一环节只允许一条有效记录
);

CREATE TABLE IF NOT EXISTS auth_codes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id     INTEGER NOT NULL REFERENCES cases(id),
  code        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'ACTIVE',     -- ACTIVE/REVOKED/USED
  issued_for  TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

-- 授权变更历史: 只增不改
CREATE TABLE IF NOT EXISTS auth_changes (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id            INTEGER NOT NULL REFERENCES cases(id),
  old_receiver       TEXT NOT NULL,
  new_receiver       TEXT NOT NULL,
  new_receiver_phone TEXT NOT NULL,
  reason             TEXT NOT NULL,
  revoked_code_id    INTEGER NOT NULL,
  new_code_id        INTEGER NOT NULL,
  operator_name      TEXT NOT NULL,
  created_at         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS exceptions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id    INTEGER NOT NULL REFERENCES cases(id),
  type       TEXT NOT NULL,
  detail     TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'OPEN',        -- OPEN/RESOLVED
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- 短信/通知出站记录: 只增不改
CREATE TABLE IF NOT EXISTS notifications (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id    INTEGER REFERENCES cases(id),
  channel    TEXT NOT NULL DEFAULT 'SMS',
  to_name    TEXT NOT NULL,
  to_phone   TEXT NOT NULL,
  body       TEXT NOT NULL,
  status     TEXT NOT NULL,                       -- SENT/FAILED
  created_at TEXT NOT NULL
);

-- 下一责任人指派(换班会改派, 属于可变的工作表, 不在交接链内)
CREATE TABLE IF NOT EXISTS assignments (
  case_id INTEGER NOT NULL REFERENCES cases(id),
  seq     INTEGER NOT NULL,
  staff_id INTEGER NOT NULL REFERENCES staff(id),
  PRIMARY KEY (case_id, seq)
);

-- ---- 交接链不可覆盖: 禁止 UPDATE / DELETE ----
CREATE TRIGGER IF NOT EXISTS trg_handover_no_update
BEFORE UPDATE ON handover_events
BEGIN SELECT RAISE(ABORT, 'handover chain is append-only'); END;

CREATE TRIGGER IF NOT EXISTS trg_handover_no_delete
BEFORE DELETE ON handover_events
BEGIN SELECT RAISE(ABORT, 'handover chain is append-only'); END;

CREATE TRIGGER IF NOT EXISTS trg_authchg_no_update
BEFORE UPDATE ON auth_changes
BEGIN SELECT RAISE(ABORT, 'auth change log is append-only'); END;

CREATE TRIGGER IF NOT EXISTS trg_authchg_no_delete
BEFORE DELETE ON auth_changes
BEGIN SELECT RAISE(ABORT, 'auth change log is append-only'); END;

CREATE TRIGGER IF NOT EXISTS trg_notify_no_update
BEFORE UPDATE ON notifications
BEGIN SELECT RAISE(ABORT, 'notification log is append-only'); END;

CREATE TRIGGER IF NOT EXISTS trg_notify_no_delete
BEFORE DELETE ON notifications
BEGIN SELECT RAISE(ABORT, 'notification log is append-only'); END;
"""


class Database:
    """轻量连接工厂: 每个线程/请求各自取连接, 便于并发签收测试。"""

    def __init__(self, path):
        self.path = path
        self._local = threading.local()
        self.init()

    def init(self):
        conn = sqlite3.connect(self.path)
        try:
            conn.executescript(SCHEMA)
            conn.commit()
            conn.execute("PRAGMA journal_mode=WAL")
        finally:
            conn.close()

    def connect(self):
        conn = sqlite3.connect(self.path, timeout=30)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute("PRAGMA busy_timeout = 30000")
        return conn
