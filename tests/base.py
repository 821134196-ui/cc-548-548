"""测试基座: 每个用例独立临时库 + 固定工作人员/航班。"""
import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from umms.db import Database
from umms.service import UmService

STAFF = [
    ("王柜台", "counter", "PEK"),      # id 1
    ("赵地面", "ground", "PEK"),       # id 2
    ("刘地面", "ground", "PEK"),       # id 3
    ("陈乘务", "crew", None),          # id 4
    ("周到达", "arrival", "SHA"),      # id 5
    ("吴到达", "arrival", "NKG"),      # id 6
    ("钱到达", "arrival", "CAN"),      # id 7
]

FLIGHT = ("CA100", "2026-10-02", "PEK", "SHA",
          "2026-10-02 09:00", "2026-10-02 11:00")

CASE = dict(
    child_name="测试儿童", child_age=8, child_gender="男",
    doc_type="居民身份证", doc_number="110105201801011234",
    care_notes="无",
    sender_name="送机父亲", sender_phone="13800001111",
    sender_id_number="110105198001011111", sender_relation="父亲",
    receiver_name="接机母亲", receiver_phone="13900002222",
    receiver_id_number="310110198202022222", receiver_relation="母亲",
    flight_no=FLIGHT[0], flight_date=FLIGHT[1], seat="10A",
)


class UmTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="umms-test-")
        self.db = Database(os.path.join(self.tmp, "test.db"))
        conn = self.db.connect()
        conn.executemany("INSERT INTO staff (name, role, station) VALUES (?,?,?)", STAFF)
        conn.execute(
            """INSERT INTO flights (flight_no, flight_date, origin, destination,
               sched_dep, sched_arr) VALUES (?,?,?,?,?,?)""", FLIGHT)
        conn.commit()
        conn.close()
        self.svc = UmService(self.db)
        self.case_id, self.code = self.svc.create_case(dict(CASE))

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    # ---- 常用辅助 ----
    def active_code(self):
        conn = self.db.connect()
        row = conn.execute(
            "SELECT code FROM auth_codes WHERE case_id=? AND status='ACTIVE'",
            (self.case_id,)).fetchone()
        conn.close()
        return row["code"]

    def events(self):
        conn = self.db.connect()
        rows = [dict(r) for r in conn.execute(
            "SELECT * FROM handover_events WHERE case_id=? ORDER BY seq",
            (self.case_id,)).fetchall()]
        conn.close()
        return rows

    def sign_first_three(self):
        self.svc.sign_handover(self.case_id, 2)   # 地面 PEK
        self.svc.sign_handover(self.case_id, 4)   # 乘务
        self.svc.sign_handover(self.case_id, 5)   # 到达 SHA
