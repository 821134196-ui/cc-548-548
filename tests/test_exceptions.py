"""异常路径与岗位最小可见的补充测试。"""
import unittest

from base import UmTestCase, CASE
from umms.service import DomainError


class TestExceptionPaths(UmTestCase):

    def test_doc_mismatch_blocks_pickup_and_raises_exception(self):
        self.sign_first_three()
        with self.assertRaises(DomainError) as ctx:
            self.svc.pickup(self.case_id, self.active_code(), "999999999999999999", 5)
        self.assertEqual(ctx.exception.code, "DOC_MISMATCH")
        conn = self.db.connect()
        exc = conn.execute(
            "SELECT * FROM exceptions WHERE case_id=? AND type='DOC_MISMATCH'",
            (self.case_id,)).fetchall()
        conn.close()
        self.assertEqual(len(exc), 1)
        # 案例仍未完成, 正确证件可继续领取
        self.svc.pickup(self.case_id, self.active_code(), "310110198202022222", 5)

    def test_diversion_creates_exception_and_notifications(self):
        self.svc.divert_flight("CA100", "2026-10-02", "NKG", "2026-10-02 12:30")
        conn = self.db.connect()
        exc = conn.execute(
            "SELECT * FROM exceptions WHERE case_id=? AND type='DIVERSION'",
            (self.case_id,)).fetchall()
        notes = conn.execute(
            "SELECT * FROM notifications WHERE case_id=?", (self.case_id,)).fetchall()
        station = conn.execute("SELECT arrival_station FROM cases WHERE id=?",
                               (self.case_id,)).fetchone()["arrival_station"]
        conn.close()
        self.assertEqual(len(exc), 1)
        self.assertEqual(station, "NKG")
        self.assertGreaterEqual(len(notes), 2)   # 送机人 + 接机人

    def test_unreachable_family_auto_exception(self):
        # 送机人手机号尾号 000 → 模拟网关失败 → 自动产生 FAMILY_UNREACHABLE
        data = dict(CASE, sender_phone="13800000000")
        case_id, _ = self.svc.create_case(data)
        conn = self.db.connect()
        exc = conn.execute(
            "SELECT * FROM exceptions WHERE case_id=? AND type='FAMILY_UNREACHABLE'",
            (case_id,)).fetchall()
        failed = conn.execute(
            "SELECT * FROM notifications WHERE case_id=? AND status='FAILED'",
            (case_id,)).fetchall()
        conn.close()
        self.assertGreaterEqual(len(failed), 1)
        self.assertGreaterEqual(len(exc), 1)

    def test_child_unwell_notifies_family(self):
        self.svc.report_exception(self.case_id, "CHILD_UNWELL", "轻微发热", 2)
        conn = self.db.connect()
        notes = conn.execute(
            "SELECT * FROM notifications WHERE case_id=? AND body LIKE '%身体不适%'",
            (self.case_id,)).fetchall()
        conn.close()
        self.assertGreaterEqual(len(notes), 1)

    def test_shift_change_reassigns_next_responsible(self):
        before = self.svc.case_detail(self.case_id)["next_responsible"]
        self.assertEqual(before["staff_id"], 2)          # 默认赵地面
        self.svc.shift_change(self.case_id, 3, "赵地面班次结束", 1)
        after = self.svc.case_detail(self.case_id)["next_responsible"]
        self.assertEqual(after["staff_id"], 3)           # 改派刘地面
        # 改派后由新责任人签收
        self.svc.sign_handover(self.case_id, 3)
        self.assertEqual(self.events()[0]["signed_by_name"], "刘地面")

    def test_delay_updates_eta_and_notifies(self):
        r = self.svc.delay_flight("CA100", "2026-10-02", 45)
        self.assertEqual(r["est_arr"], "2026-10-02 11:45")
        conn = self.db.connect()
        exc = conn.execute(
            "SELECT * FROM exceptions WHERE case_id=? AND type='DELAY'",
            (self.case_id,)).fetchall()
        conn.close()
        self.assertEqual(len(exc), 1)


class TestMinimalVisibility(UmTestCase):

    def test_role_based_profile_fields(self):
        d_crew = self.svc.case_detail(self.case_id, role="crew")
        # 乘务组: 看不到姓名与任何联系方式
        self.assertNotIn("child_name", d_crew["profile"])
        self.assertNotIn("sender", d_crew["profile"])
        self.assertNotIn("receiver", d_crew["profile"])
        self.assertIn("care_notes", d_crew["profile"])

        d_counter = self.svc.case_detail(self.case_id, role="counter")
        self.assertIn("sender", d_counter["profile"])
        self.assertIn("receiver", d_counter["profile"])

        d_arrival = self.svc.case_detail(self.case_id, role="arrival")
        # 到达站: 接机人信息遮罩
        self.assertIn("****", d_arrival["profile"]["receiver_masked"]["phone"])

    def test_auth_code_hidden_from_crew(self):
        d = self.svc.case_detail(self.case_id, role="crew")
        self.assertTrue(all(a["code"] == "******" for a in d["auth"]))
        d2 = self.svc.case_detail(self.case_id, role="arrival")
        self.assertTrue(any(a["code"] != "******" for a in d2["auth"]))


if __name__ == "__main__":
    unittest.main()
