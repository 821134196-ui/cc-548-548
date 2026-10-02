"""业务逻辑: 登记、逐段签收、授权变更、异常路径、到达领取、岗位最小可见。"""
import random
import re
from datetime import datetime, timedelta

from .adapters import FlightAdapter, SmsAdapter

# ---------------------------------------------------------------- 常量

ROLE_NAMES = {"counter": "值机柜台", "ground": "地面人员",
              "crew": "乘务组", "arrival": "到达站人员"}

# 交接链固定四段; where 决定该段应在哪个站点签收
SEGMENTS = [
    {"seq": 1, "key": "COUNTER_TO_GROUND", "label": "柜台 → 地面人员",
     "to_role": "ground", "where": "origin",  "location": "{st} 航站楼 值机柜台"},
    {"seq": 2, "key": "GROUND_TO_CREW", "label": "地面人员 → 乘务组",
     "to_role": "crew",   "where": "origin",  "location": "{st} 登机口"},
    {"seq": 3, "key": "CREW_TO_ARRIVAL", "label": "乘务组 → 到达站人员",
     "to_role": "arrival", "where": "arrival", "location": "{st} 到达厅 UM 交接点"},
    {"seq": 4, "key": "ARRIVAL_TO_RECEIVER", "label": "到达站人员 → 接机人",
     "to_role": "arrival", "where": "arrival", "location": "{st} 到达厅 UM 交接点"},
]

EXCEPTION_TYPES = {
    "DELAY": "航班延误",
    "DIVERSION": "航班改降",
    "RECEIVER_CHANGE": "接机人更换",
    "DOC_MISMATCH": "证件不一致",
    "CHILD_UNWELL": "儿童身体不适",
    "SHIFT_CHANGE": "交接人临时换班",
    "FAMILY_UNREACHABLE": "联系不上家属",
}

# 岗位最小可见: 每个岗位可见的旅客档案字段
PROFILE_FIELDS = {
    "counter": ["code", "child_name", "child_age", "child_gender", "doc_type",
                "doc_masked", "doc_mask_image", "care_notes", "flight", "seat",
                "sender", "receiver"],
    "ground":  ["code", "child_name", "child_age", "flight", "seat",
                "care_notes", "sender"],
    "crew":    ["code", "child_age", "child_gender", "seat", "care_notes"],
    "arrival": ["code", "child_name", "flight", "care_notes", "receiver_masked"],
}


class DomainError(Exception):
    """业务规则拒绝。code 供前端/测试断言。"""

    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


def now_str():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def mask_doc(number):
    """证件号遮罩: 保留前4后4。"""
    if len(number) <= 8:
        return number[0] + "*" * (len(number) - 1)
    return number[:4] + "*" * (len(number) - 8) + number[-4:]


def mask_phone(phone):
    return phone[:3] + "****" + phone[-4:] if len(phone) >= 7 else "****"


def mask_name(name):
    return name[0] + "*" if len(name) > 1 else name


# ---------------------------------------------------------------- 服务

class UmService:
    def __init__(self, db, flight_adapter=None, sms_adapter=None):
        self.db = db
        self.flights = flight_adapter or FlightAdapter(db)
        self.sms = sms_adapter or SmsAdapter()

    # ---------------- 内部工具 ----------------

    def _case(self, conn, case_id):
        row = conn.execute("SELECT * FROM cases WHERE id=?", (case_id,)).fetchone()
        if not row:
            raise DomainError("CASE_NOT_FOUND", f"案例 {case_id} 不存在")
        return dict(row)

    def _staff(self, conn, staff_id):
        row = conn.execute("SELECT * FROM staff WHERE id=?", (staff_id,)).fetchone()
        if not row:
            raise DomainError("STAFF_NOT_FOUND", f"工作人员 {staff_id} 不存在")
        return dict(row)

    def _events(self, conn, case_id):
        return [dict(r) for r in conn.execute(
            "SELECT * FROM handover_events WHERE case_id=? ORDER BY seq",
            (case_id,)).fetchall()]

    def _next_seq(self, conn, case_id):
        row = conn.execute(
            "SELECT COALESCE(MAX(seq),0)+1 AS n FROM handover_events WHERE case_id=?",
            (case_id,)).fetchone()
        return row["n"]

    def _segment_station(self, case, segment):
        return case["origin"] if segment["where"] == "origin" else case["arrival_station"]

    def _notify(self, conn, case_id, to_name, to_phone, body):
        """经模拟短信网关发送并落库; 失败自动触发"联系不上家属"异常。"""
        result = self.sms.send(to_phone, body)
        conn.execute(
            "INSERT INTO notifications (case_id, channel, to_name, to_phone, body, status, created_at)"
            " VALUES (?,?,?,?,?,?,?)",
            (case_id, "SMS", to_name, to_phone, body,
             "SENT" if result["ok"] else "FAILED", now_str()))
        if not result["ok"]:
            self._raise_exception(
                conn, case_id, "FAMILY_UNREACHABLE",
                f"短信无法送达 {to_name}({mask_phone(to_phone)}): {result['error']}, 已升级值班主管",
                "系统")

    def _raise_exception(self, conn, case_id, type_, detail, created_by):
        if type_ not in EXCEPTION_TYPES:
            raise DomainError("BAD_EXCEPTION_TYPE", f"未知异常类型 {type_}")
        cur = conn.execute(
            "INSERT INTO exceptions (case_id, type, detail, status, created_by, created_at)"
            " VALUES (?,?,?,'OPEN',?,?)",
            (case_id, type_, detail, created_by, now_str()))
        return cur.lastrowid

    def _issue_code(self, conn, case_id, receiver_name):
        code = f"{random.SystemRandom().randrange(0, 1000000):06d}"
        cur = conn.execute(
            "INSERT INTO auth_codes (case_id, code, status, issued_for, created_at)"
            " VALUES (?,?, 'ACTIVE', ?, ?)",
            (case_id, code, receiver_name, now_str()))
        return cur.lastrowid, code

    # ---------------- 登记 ----------------

    def create_case(self, data):
        """柜台登记: 核验送机人身份后建案并签发交接单(授权码经短信下发)。"""
        required = ["child_name", "child_age", "child_gender", "doc_type", "doc_number",
                    "sender_name", "sender_phone", "sender_id_number", "sender_relation",
                    "receiver_name", "receiver_phone", "receiver_id_number",
                    "receiver_relation", "flight_no", "flight_date", "seat"]
        missing = [k for k in required if not str(data.get(k, "")).strip()]
        if missing:
            raise DomainError("MISSING_FIELD", "缺少字段: " + ", ".join(missing))

        conn = self.db.connect()
        try:
            flight = conn.execute(
                "SELECT * FROM flights WHERE flight_no=? AND flight_date=?",
                (data["flight_no"], data["flight_date"])).fetchone()
            if not flight:
                raise DomainError("FLIGHT_NOT_FOUND",
                                  f"航班 {data['flight_no']} {data['flight_date']} 不存在")

            code = data.get("code") or self._gen_case_code(conn)
            cur = conn.execute(
                """INSERT INTO cases (code, child_name, child_age, child_gender, doc_type,
                   doc_number, doc_mask_image, care_notes, sender_name, sender_phone,
                   sender_id_number, sender_relation, receiver_name, receiver_phone,
                   receiver_id_number, receiver_relation, flight_no, flight_date, seat,
                   origin, arrival_station, status, created_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'OPEN', ?)""",
                (code, data["child_name"], int(data["child_age"]), data["child_gender"],
                 data["doc_type"], data["doc_number"], data.get("doc_mask_image", ""),
                 data.get("care_notes", ""), data["sender_name"], data["sender_phone"],
                 data["sender_id_number"], data["sender_relation"], data["receiver_name"],
                 data["receiver_phone"], data["receiver_id_number"],
                 data["receiver_relation"], data["flight_no"], data["flight_date"],
                 data["seat"], flight["origin"], flight["destination"], now_str()))
            case_id = cur.lastrowid

            _, auth_code = self._issue_code(conn, case_id, data["receiver_name"])
            self._notify(conn, case_id, data["sender_name"], data["sender_phone"],
                         f"【UM交接】儿童代号 {code} 已登记, 航班 {data['flight_no']}, "
                         f"接机授权码 {auth_code}(仅接机人本人使用)。")
            self._notify(conn, case_id, data["receiver_name"], data["receiver_phone"],
                         f"【UM交接】您被登记为 {code} 的接机人, 航班 {data['flight_no']}, "
                         f"接机授权码 {auth_code}, 请携带本人证件领取。")
            conn.commit()
            return case_id, code
        finally:
            conn.close()

    def _gen_case_code(self, conn):
        alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
        for _ in range(50):
            code = "UM-" + "".join(random.SystemRandom().choice(alphabet) for _ in range(4))
            if not conn.execute("SELECT 1 FROM cases WHERE code=?", (code,)).fetchone():
                return code
        raise DomainError("CODE_EXHAUSTED", "无法生成唯一儿童代号")

    # ---------------- 逐段签收 ----------------

    def sign_handover(self, case_id, staff_id, note=""):
        """签收下一环节。规则:
        - 上一环节未签收不得跳过(按 seq 严格递增);
        - 签收人岗位必须等于该环节的接收岗位;
        - 签收人站点必须与环节站点一致(乘务组随机组流动除外);
        - 同一环节并发签收只落一条(UNIQUE + 事务内检查);
        - 第4段(交予接机人)必须走 pickup() 核验授权码与证件。
        """
        conn = self.db.connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            case = self._case(conn, case_id)
            staff = self._staff(conn, staff_id)
            if case["status"] == "COMPLETED":
                raise DomainError("ALREADY_COMPLETED", "该儿童已完成交接领取")
            seq = self._next_seq(conn, case_id)
            if seq > 4:
                raise DomainError("ALREADY_COMPLETED", "交接链已完成")
            segment = SEGMENTS[seq - 1]
            if segment["key"] == "ARRIVAL_TO_RECEIVER":
                raise DomainError("USE_PICKUP", "最终领取须在到达领取页核验授权码与证件")

            self._check_staff_for_segment(case, staff, segment)

            events = self._events(conn, case_id)
            from_label = (f"{case['sender_name']}(送机人)" if not events
                          else events[-1]["to_label"])
            station = self._segment_station(case, segment)
            to_label = f"{staff['name']}({ROLE_NAMES[staff['role']]})"
            conn.execute(
                """INSERT INTO handover_events
                   (case_id, seq, segment, station, location, from_label, to_label,
                    staff_id, signed_by_name, signed_by_role, note, created_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
                (case_id, seq, segment["label"], station,
                 segment["location"].format(st=station), from_label, to_label,
                 staff["id"], staff["name"], staff["role"], note, now_str()))
            if seq == 1:
                conn.execute("UPDATE cases SET status='IN_TRANSIT' WHERE id=?", (case_id,))
                self._notify(conn, case_id, case["sender_name"], case["sender_phone"],
                             f"【UM交接】{case['code']} 已由柜台移交地面人员, 航班 {case['flight_no']}。")
            if seq == 3:
                self._notify(conn, case_id, case["receiver_name"], case["receiver_phone"],
                             f"【UM交接】{case['code']} 已到达 {station}, "
                             f"请携授权码与本人证件至到达厅 UM 交接点领取。")
            conn.commit()
            return {"seq": seq, "segment": segment["label"], "station": station}
        except DomainError:
            conn.rollback()
            raise
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    def _check_staff_for_segment(self, case, staff, segment):
        if not staff["on_duty"]:
            raise DomainError("STAFF_OFF_DUTY", f"{staff['name']} 已换班离岗, 不能签收")
        if staff["role"] != segment["to_role"]:
            raise DomainError(
                "WRONG_ROLE",
                f"环节「{segment['label']}」须由{ROLE_NAMES[segment['to_role']]}签收, "
                f"当前为{ROLE_NAMES[staff['role']]}")
        required = self._segment_station(case, segment)
        # 乘务组 station 为 NULL: 随机组流动, 不受站点限制
        if staff["station"] is not None and staff["station"] != required:
            raise DomainError(
                "WRONG_STATION",
                f"跨站签收被拒绝: 该环节须在 {required} 办理, "
                f"{staff['name']} 属于 {staff['station']}")

    # ---------------- 到达领取 ----------------

    def pickup(self, case_id, auth_code, doc_number, staff_id):
        """接机人领取: 核验授权码(旧码已失效) + 证件一致性, 然后落第4段。"""
        conn = self.db.connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            case = self._case(conn, case_id)
            staff = self._staff(conn, staff_id)
            if case["status"] == "COMPLETED":
                raise DomainError("ALREADY_COMPLETED", "该儿童已被领取")
            if self._next_seq(conn, case_id) != 4:
                raise DomainError("NOT_READY", "上一环节未签收, 不能进入领取环节")
            if staff["role"] != "arrival":
                raise DomainError("WRONG_ROLE", "领取环节须由到达站人员办理")
            if staff["station"] is not None and staff["station"] != case["arrival_station"]:
                raise DomainError("WRONG_STATION",
                                  f"领取须在 {case['arrival_station']} 办理")

            row = conn.execute(
                "SELECT * FROM auth_codes WHERE case_id=? AND code=?",
                (case_id, auth_code)).fetchone()
            if not row:
                raise DomainError("AUTH_INVALID", "授权码无效")
            if row["status"] == "REVOKED":
                raise DomainError("AUTH_REVOKED", "该授权码已因接机人变更而失效")
            if row["status"] == "USED":
                raise DomainError("AUTH_USED", "该授权码已被使用")

            if doc_number != case["receiver_id_number"]:
                self._raise_exception(
                    conn, case_id, "DOC_MISMATCH",
                    f"领取人证件与登记接机人 {case['receiver_name']} 不一致, 领取被拒绝, "
                    f"已通知送机人并升级值班主管", staff["name"])
                self._notify(conn, case_id, case["sender_name"], case["sender_phone"],
                             f"【UM交接】警示: 有人持不一致证件尝试领取 {case['code']}, 已拦截。")
                conn.commit()
                raise DomainError("DOC_MISMATCH", "证件与登记接机人不一致, 已触发异常流程")

            events = self._events(conn, case_id)
            station = case["arrival_station"]
            conn.execute(
                """INSERT INTO handover_events
                   (case_id, seq, segment, station, location, from_label, to_label,
                    staff_id, signed_by_name, signed_by_role, note, created_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
                (case_id, 4, SEGMENTS[3]["label"], station,
                 SEGMENTS[3]["location"].format(st=station),
                 events[-1]["to_label"], f"{case['receiver_name']}(接机人)",
                 staff["id"], staff["name"], "arrival",
                 "授权码与证件核验通过", now_str()))
            conn.execute("UPDATE auth_codes SET status='USED' WHERE id=?", (row["id"],))
            conn.execute("UPDATE cases SET status='COMPLETED' WHERE id=?", (case_id,))
            self._notify(conn, case_id, case["sender_name"], case["sender_phone"],
                         f"【UM交接】{case['code']} 已由授权接机人 {case['receiver_name']} 领取。")
            conn.commit()
            return {"seq": 4, "segment": SEGMENTS[3]["label"], "station": station}
        except DomainError:
            conn.rollback()
            raise
        finally:
            conn.close()

    # ---------------- 授权变更 ----------------

    def change_receiver(self, case_id, new_receiver, reason, staff_id):
        """接机人更换: 旧授权码立即失效, 签发新码并留痕。"""
        for k in ("name", "phone", "id_number", "relation"):
            if not str(new_receiver.get(k, "")).strip():
                raise DomainError("MISSING_FIELD", f"缺少新接机人字段: {k}")
        conn = self.db.connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            case = self._case(conn, case_id)
            staff = self._staff(conn, staff_id)
            if case["status"] == "COMPLETED":
                raise DomainError("ALREADY_COMPLETED", "已领取, 不能再变更接机人")
            if staff["role"] not in ("counter", "arrival"):
                raise DomainError("WRONG_ROLE", "仅柜台或到达站可办理接机人变更")

            old = conn.execute(
                "SELECT * FROM auth_codes WHERE case_id=? AND status='ACTIVE'",
                (case_id,)).fetchone()
            if not old:
                raise DomainError("NO_ACTIVE_CODE", "无有效授权码可作废")
            # 旧码失效
            conn.execute("UPDATE auth_codes SET status='REVOKED' WHERE id=?", (old["id"],))

            old_receiver = case["receiver_name"]
            conn.execute(
                """UPDATE cases SET receiver_name=?, receiver_phone=?,
                   receiver_id_number=?, receiver_relation=? WHERE id=?""",
                (new_receiver["name"], new_receiver["phone"],
                 new_receiver["id_number"], new_receiver["relation"], case_id))
            new_id, new_code = self._issue_code(conn, case_id, new_receiver["name"])
            conn.execute(
                """INSERT INTO auth_changes
                   (case_id, old_receiver, new_receiver, new_receiver_phone, reason,
                    revoked_code_id, new_code_id, operator_name, created_at)
                   VALUES (?,?,?,?,?,?,?,?,?)""",
                (case_id, old_receiver, new_receiver["name"], new_receiver["phone"],
                 reason, old["id"], new_id, staff["name"], now_str()))
            self._raise_exception(conn, case_id, "RECEIVER_CHANGE",
                                  f"接机人由 {old_receiver} 变更为 {new_receiver['name']}, "
                                  f"旧授权码已失效。原因: {reason}", staff["name"])
            self._notify(conn, case_id, case["sender_name"], case["sender_phone"],
                         f"【UM交接】{case['code']} 接机人已变更为 {new_receiver['name']}, "
                         f"原授权码已失效。")
            self._notify(conn, case_id, new_receiver["name"], new_receiver["phone"],
                         f"【UM交接】您已成为 {case['code']} 的接机人, "
                         f"新授权码 {new_code}, 原接机人授权码已失效。")
            conn.commit()
            return {"new_code": new_code}
        except DomainError:
            conn.rollback()
            raise
        finally:
            conn.close()

    # ---------------- 异常路径 ----------------

    def report_exception(self, case_id, type_, detail, staff_id=None):
        """通用异常上报(儿童身体不适等)。"""
        conn = self.db.connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            case = self._case(conn, case_id)
            creator = "系统"
            if staff_id is not None:
                creator = self._staff(conn, staff_id)["name"]
            exc_id = self._raise_exception(conn, case_id, type_, detail, creator)
            if type_ == "CHILD_UNWELL":
                self._notify(conn, case_id, case["sender_name"], case["sender_phone"],
                             f"【UM交接】{case['code']} 身体不适: {detail}。工作人员已陪护并联系航医。")
                self._notify(conn, case_id, case["receiver_name"], case["receiver_phone"],
                             f"【UM交接】{case['code']} 身体不适: {detail}。到达站将另行通知领取安排。")
            conn.commit()
            return exc_id
        finally:
            conn.close()

    def shift_change(self, case_id, new_staff_id, reason, staff_id):
        """交接人临时换班: 改派当前环节的下一责任人并留痕。"""
        conn = self.db.connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            case = self._case(conn, case_id)
            operator = self._staff(conn, staff_id)
            new_staff = self._staff(conn, new_staff_id)
            seq = self._next_seq(conn, case_id)
            if seq > 4:
                raise DomainError("ALREADY_COMPLETED", "交接链已完成")
            segment = SEGMENTS[seq - 1]
            self._check_staff_for_segment(case, new_staff, segment)
            conn.execute(
                "INSERT OR REPLACE INTO assignments (case_id, seq, staff_id) VALUES (?,?,?)",
                (case_id, seq, new_staff_id))
            self._raise_exception(
                conn, case_id, "SHIFT_CHANGE",
                f"环节「{segment['label']}」责任人改派为 {new_staff['name']}。原因: {reason}",
                operator["name"])
            conn.commit()
            return {"seq": seq, "new_staff": new_staff["name"]}
        except DomainError:
            conn.rollback()
            raise
        finally:
            conn.close()

    def retry_notify_family(self, case_id, staff_id=None):
        """联系不上家属的应急路径: 值班人员重试并记录。"""
        conn = self.db.connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            case = self._case(conn, case_id)
            self._notify(conn, case_id, case["sender_name"], case["sender_phone"],
                         f"【UM交接】请尽快与 {case['arrival_station']} 到达站联系, "
                         f"确认 {case['code']} 的领取安排。")
            self._notify(conn, case_id, case["receiver_name"], case["receiver_phone"],
                         f"【UM交接】请尽快与 {case['arrival_station']} 到达站联系, "
                         f"确认 {case['code']} 的领取安排。")
            conn.commit()
        finally:
            conn.close()

    # ---------------- 航班异常(模拟适配器驱动) ----------------

    def delay_flight(self, flight_no, flight_date, minutes):
        flight = self.flights.get(flight_no, flight_date)
        if not flight:
            raise DomainError("FLIGHT_NOT_FOUND", "航班不存在")
        base = flight["est_arr"] or flight["sched_arr"]
        new_est = (datetime.strptime(base, "%Y-%m-%d %H:%M")
                   + timedelta(minutes=int(minutes))).strftime("%Y-%m-%d %H:%M")
        self.flights.apply_delay(flight_no, flight_date, minutes, new_est)
        conn = self.db.connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            for case in self._open_cases_on_flight(conn, flight_no, flight_date):
                self._raise_exception(conn, case["id"], "DELAY",
                                      f"航班 {flight_no} 延误 {minutes} 分钟, "
                                      f"预计到达 {new_est}", "运行控制")
                self._notify(conn, case["id"], case["receiver_name"], case["receiver_phone"],
                             f"【UM交接】航班 {flight_no} 延误约 {minutes} 分钟, "
                             f"预计 {new_est} 到达, 请合理安排接机。")
            conn.commit()
        finally:
            conn.close()
        return {"est_arr": new_est}

    def divert_flight(self, flight_no, flight_date, new_station, new_est_arr=None):
        """改降: 更新航班与在途案例的到达站, 交接链在新站点继续。"""
        flight = self.flights.get(flight_no, flight_date)
        if not flight:
            raise DomainError("FLIGHT_NOT_FOUND", "航班不存在")
        est = new_est_arr or flight["sched_arr"]
        self.flights.apply_diversion(flight_no, flight_date, new_station, est)
        conn = self.db.connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            for case in self._open_cases_on_flight(conn, flight_no, flight_date):
                conn.execute("UPDATE cases SET arrival_station=? WHERE id=?",
                             (new_station, case["id"]))
                self._raise_exception(
                    conn, case["id"], "DIVERSION",
                    f"航班 {flight_no} 改降 {new_station}(原计划 {flight['destination']}), "
                    f"到达交接改由 {new_station} 办理", "运行控制")
                self._notify(conn, case["id"], case["sender_name"], case["sender_phone"],
                             f"【UM交接】航班 {flight_no} 已改降 {new_station}, "
                             f"{case['code']} 将由 {new_station} 到达站人员接应。")
                self._notify(conn, case["id"], case["receiver_name"], case["receiver_phone"],
                             f"【UM交接】航班 {flight_no} 已改降 {new_station}, "
                             f"领取地点变更为 {new_station} 到达厅 UM 交接点。")
            conn.commit()
        finally:
            conn.close()
        return {"diverted_to": new_station}

    def _open_cases_on_flight(self, conn, flight_no, flight_date):
        return [dict(r) for r in conn.execute(
            "SELECT * FROM cases WHERE flight_no=? AND flight_date=? AND status!='COMPLETED'",
            (flight_no, flight_date)).fetchall()]

    # ---------------- 查询 ----------------

    def list_cases(self):
        conn = self.db.connect()
        try:
            out = []
            for row in conn.execute("SELECT * FROM cases ORDER BY id DESC").fetchall():
                case = dict(row)
                case["progress"] = conn.execute(
                    "SELECT COUNT(*) AS c FROM handover_events WHERE case_id=?",
                    (case["id"],)).fetchone()["c"]
                case["open_exceptions"] = conn.execute(
                    "SELECT COUNT(*) AS c FROM exceptions WHERE case_id=? AND status='OPEN'",
                    (case["id"],)).fetchone()["c"]
                out.append(case)
            return out
        finally:
            conn.close()

    def case_detail(self, case_id, role="counter"):
        conn = self.db.connect()
        try:
            case = self._case(conn, case_id)
            flight = self.flights.get(case["flight_no"], case["flight_date"])
            events = self._events(conn, case_id)
            next_seq = len(events) + 1
            detail = {
                "profile": self._profile_for_role(case, role),
                "flight": flight,
                "status": case["status"],
                "arrival_station": case["arrival_station"],
                "events": events,
                "segments": self._segment_states(case, events),
                "next_responsible": (self.next_responsible(conn, case, next_seq)
                                     if next_seq <= 4 else None),
                "exceptions": [dict(r) for r in conn.execute(
                    "SELECT * FROM exceptions WHERE case_id=? ORDER BY id DESC",
                    (case_id,)).fetchall()],
                "notifications": [dict(r) for r in conn.execute(
                    "SELECT * FROM notifications WHERE case_id=? ORDER BY id DESC",
                    (case_id,)).fetchall()],
                "auth_changes": [dict(r) for r in conn.execute(
                    "SELECT * FROM auth_changes WHERE case_id=? ORDER BY id DESC",
                    (case_id,)).fetchall()],
                "auth": self._auth_view(conn, case_id, role),
            }
            return detail
        finally:
            conn.close()

    def _auth_view(self, conn, case_id, role):
        rows = [dict(r) for r in conn.execute(
            "SELECT * FROM auth_codes WHERE case_id=? ORDER BY id DESC", (case_id,)).fetchall()]
        # 授权码明文仅柜台/到达站可见, 其余岗位只见状态
        if role not in ("counter", "arrival"):
            for r in rows:
                r["code"] = "******"
        return rows

    def _segment_states(self, case, events):
        by_seq = {e["seq"]: e for e in events}
        states = []
        for seg in SEGMENTS:
            station = self._segment_station(case, seg)
            ev = by_seq.get(seg["seq"])
            states.append({
                "seq": seg["seq"], "key": seg["key"], "label": seg["label"],
                "station": station,
                "location": seg["location"].format(st=station),
                "signed": ev is not None,
                "event": ev,
            })
        return states

    def next_responsible(self, conn, case, next_seq):
        """下一责任人: 优先换班指派, 否则取该环节岗位在该站点的在岗人员。"""
        segment = SEGMENTS[next_seq - 1]
        station = self._segment_station(case, segment)
        row = conn.execute(
            """SELECT s.* FROM assignments a JOIN staff s ON s.id=a.staff_id
               WHERE a.case_id=? AND a.seq=? AND s.on_duty=1""",
            (case["id"], next_seq)).fetchone()
        if not row:
            if segment["to_role"] == "crew":
                row = conn.execute(
                    "SELECT * FROM staff WHERE role='crew' AND on_duty=1 ORDER BY id LIMIT 1"
                ).fetchone()
            else:
                row = conn.execute(
                    "SELECT * FROM staff WHERE role=? AND station=? AND on_duty=1 "
                    "ORDER BY id LIMIT 1", (segment["to_role"], station)).fetchone()
        if not row:
            return None
        staff = dict(row)
        return {"staff_id": staff["id"], "name": staff["name"],
                "role": staff["role"], "role_name": ROLE_NAMES[staff["role"]],
                "station": staff["station"] or "随机组",
                "segment": segment["label"],
                "location": segment["location"].format(st=station)}

    def _profile_for_role(self, case, role):
        """岗位最小可见: 按角色裁剪旅客档案。"""
        flight_str = f"{case['flight_no']} {case['origin']}→{case['arrival_station']}"
        full = {
            "code": case["code"],
            "child_name": case["child_name"],
            "child_age": case["child_age"],
            "child_gender": case["child_gender"],
            "doc_type": case["doc_type"],
            "doc_masked": mask_doc(case["doc_number"]),
            "doc_mask_image": case["doc_mask_image"],
            "care_notes": case["care_notes"],
            "flight": flight_str,
            "seat": case["seat"],
            "sender": {"name": case["sender_name"], "phone": case["sender_phone"],
                       "relation": case["sender_relation"],
                       "id_masked": mask_doc(case["sender_id_number"])},
            "receiver": {"name": case["receiver_name"], "phone": case["receiver_phone"],
                         "relation": case["receiver_relation"],
                         "id_masked": mask_doc(case["receiver_id_number"])},
            "receiver_masked": {"name": mask_name(case["receiver_name"]),
                                "phone": mask_phone(case["receiver_phone"]),
                                "relation": case["receiver_relation"]},
        }
        fields = PROFILE_FIELDS.get(role, PROFILE_FIELDS["crew"])
        return {k: full[k] for k in fields}

    def list_staff(self):
        conn = self.db.connect()
        try:
            return [dict(r) for r in conn.execute(
                "SELECT * FROM staff ORDER BY station, role, id").fetchall()]
        finally:
            conn.close()
