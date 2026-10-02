"""重复签收: 两名工作人员同时交接, 只能有一条有效记录。"""
import threading
import unittest

from base import UmTestCase
from umms.service import DomainError


class TestDuplicateSignoff(UmTestCase):

    def test_concurrent_sign_same_segment_single_record(self):
        # 赵地面(id2)与刘地面(id3)同时签收第1段
        barrier = threading.Barrier(2)
        results, errors = [], []

        def attempt(staff_id):
            try:
                barrier.wait(timeout=5)          # 对齐并发起点
                results.append(self.svc.sign_handover(self.case_id, staff_id))
            except DomainError as e:
                errors.append(e)

        threads = [threading.Thread(target=attempt, args=(sid,)) for sid in (2, 3)]
        for t in threads: t.start()
        for t in threads: t.join(timeout=15)

        self.assertEqual(len(results), 1, "并发签收只能成功一次")
        self.assertEqual(len(errors), 1, "另一人必须收到业务拒绝")
        # 失败原因: 该环节已被同事签收后, 轮到第2段, 地面岗位不符
        self.assertEqual(errors[0].code, "WRONG_ROLE")
        # 交接链中第1段有且只有一条记录
        seq1 = [e for e in self.events() if e["seq"] == 1]
        self.assertEqual(len(seq1), 1)

    def test_sequential_duplicate_sign_rejected(self):
        self.svc.sign_handover(self.case_id, 2)
        # 同一工作人员重复签收同一环节: 环节已推进, 视为越权/跳段
        with self.assertRaises(DomainError):
            self.svc.sign_handover(self.case_id, 2)
        self.assertEqual(len(self.events()), 1)

    def test_chain_is_append_only(self):
        self.svc.sign_handover(self.case_id, 2)
        conn = self.db.connect()
        with self.assertRaises(Exception, msg="交接链禁止 UPDATE"):
            conn.execute("UPDATE handover_events SET note='篡改' WHERE case_id=?",
                         (self.case_id,))
        with self.assertRaises(Exception, msg="交接链禁止 DELETE"):
            conn.execute("DELETE FROM handover_events WHERE case_id=?",
                         (self.case_id,))
        conn.close()
        # 记录内容未被破坏
        self.assertEqual(self.events()[0]["seq"], 1)


if __name__ == "__main__":
    unittest.main()
