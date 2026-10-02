"""顺序: 上一环节未签收不得跳过到下一环节。"""
import unittest

from base import UmTestCase
from umms.service import DomainError


class TestOrdering(UmTestCase):

    def test_cannot_skip_segment(self):
        # 未签收第1段(柜台→地面), 乘务组不能签收第2段
        with self.assertRaises(DomainError) as ctx:
            self.svc.sign_handover(self.case_id, 4)
        self.assertEqual(ctx.exception.code, "WRONG_ROLE")
        self.assertEqual(self.events(), [])

    def test_must_follow_sequence(self):
        self.svc.sign_handover(self.case_id, 2)          # 第1段
        # 第2段应由乘务组签收; 地面再来一次属于岗位不符
        with self.assertRaises(DomainError) as ctx:
            self.svc.sign_handover(self.case_id, 3)
        self.assertEqual(ctx.exception.code, "WRONG_ROLE")
        # 正确顺序可连续推进
        self.svc.sign_handover(self.case_id, 4)
        self.svc.sign_handover(self.case_id, 5)
        self.assertEqual([e["seq"] for e in self.events()], [1, 2, 3])

    def test_pickup_blocked_until_segment3_signed(self):
        # 前三段未签收完, 不能领取
        with self.assertRaises(DomainError) as ctx:
            self.svc.pickup(self.case_id, self.active_code(), "310110198202022222", 5)
        self.assertEqual(ctx.exception.code, "NOT_READY")

        self.svc.sign_handover(self.case_id, 2)
        self.svc.sign_handover(self.case_id, 4)
        with self.assertRaises(DomainError) as ctx:
            self.svc.pickup(self.case_id, self.active_code(), "310110198202022222", 5)
        self.assertEqual(ctx.exception.code, "NOT_READY")

    def test_final_segment_only_via_pickup(self):
        self.sign_first_three()
        # 第4段不能走普通签收, 必须核验授权码
        with self.assertRaises(DomainError) as ctx:
            self.svc.sign_handover(self.case_id, 5)
        self.assertEqual(ctx.exception.code, "USE_PICKUP")

    def test_full_chain_completes(self):
        self.sign_first_three()
        self.svc.pickup(self.case_id, self.active_code(), "310110198202022222", 5)
        events = self.events()
        self.assertEqual([e["seq"] for e in events], [1, 2, 3, 4])
        conn = self.db.connect()
        status = conn.execute("SELECT status FROM cases WHERE id=?",
                              (self.case_id,)).fetchone()["status"]
        conn.close()
        self.assertEqual(status, "COMPLETED")
        # 完成后任何签收都被拒绝
        with self.assertRaises(DomainError):
            self.svc.sign_handover(self.case_id, 5)


if __name__ == "__main__":
    unittest.main()
