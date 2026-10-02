"""旧码失效: 接机授权变更必须使旧码失效。"""
import unittest

from base import UmTestCase
from umms.service import DomainError

NEW_RECEIVER = {"name": "接机姑姑", "phone": "13700003333",
                "id_number": "310110199003033333", "relation": "姑母"}


class TestAuthCodeInvalidation(UmTestCase):

    def test_old_code_revoked_after_receiver_change(self):
        old_code = self.active_code()
        result = self.svc.change_receiver(self.case_id, NEW_RECEIVER, "行程冲突", 1)
        new_code = result["new_code"]
        self.assertNotEqual(old_code, new_code)

        self.sign_first_three()
        # 旧码: 明确提示已失效
        with self.assertRaises(DomainError) as ctx:
            self.svc.pickup(self.case_id, old_code, NEW_RECEIVER["id_number"], 5)
        self.assertEqual(ctx.exception.code, "AUTH_REVOKED")
        # 新码 + 新接机人证件: 通过
        self.svc.pickup(self.case_id, new_code, NEW_RECEIVER["id_number"], 5)
        self.assertEqual(len(self.events()), 4)

    def test_change_is_logged_append_only(self):
        self.svc.change_receiver(self.case_id, NEW_RECEIVER, "行程冲突", 1)
        conn = self.db.connect()
        changes = conn.execute(
            "SELECT * FROM auth_changes WHERE case_id=?", (self.case_id,)).fetchall()
        self.assertEqual(len(changes), 1)
        self.assertEqual(changes[0]["old_receiver"], "接机母亲")
        self.assertEqual(changes[0]["new_receiver"], "接机姑姑")
        # 授权变更日志不可覆盖
        with self.assertRaises(Exception):
            conn.execute("UPDATE auth_changes SET reason='篡改' WHERE id=?",
                         (changes[0]["id"],))
        with self.assertRaises(Exception):
            conn.execute("DELETE FROM auth_changes WHERE id=?", (changes[0]["id"],))
        conn.close()

    def test_used_code_cannot_be_reused(self):
        self.sign_first_three()
        code = self.active_code()
        self.svc.pickup(self.case_id, code, "310110198202022222", 5)
        with self.assertRaises(DomainError) as ctx:
            self.svc.pickup(self.case_id, code, "310110198202022222", 5)
        self.assertIn(ctx.exception.code, ("AUTH_USED", "ALREADY_COMPLETED"))

    def test_wrong_code_rejected(self):
        self.sign_first_three()
        with self.assertRaises(DomainError) as ctx:
            self.svc.pickup(self.case_id, "000000", "310110198202022222", 5)
        self.assertEqual(ctx.exception.code, "AUTH_INVALID")


if __name__ == "__main__":
    unittest.main()
