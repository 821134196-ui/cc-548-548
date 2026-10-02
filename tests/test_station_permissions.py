"""跨站权限: 工作人员只能在本站(乘务组除外)签收对应环节。"""
import unittest

from base import UmTestCase
from umms.service import DomainError


class TestStationPermissions(UmTestCase):

    def test_arrival_staff_cannot_sign_origin_segment(self):
        # SHA 到达站人员不能签收 PEK 的「柜台→地面」环节
        with self.assertRaises(DomainError) as ctx:
            self.svc.sign_handover(self.case_id, 5)
        self.assertEqual(ctx.exception.code, "WRONG_ROLE")

    def test_wrong_station_rejected(self):
        self.svc.sign_handover(self.case_id, 2)   # PEK 地面
        self.svc.sign_handover(self.case_id, 4)   # 乘务
        # 第3段须在 SHA 签收; NKG/CAN 到达人员跨站签收被拒
        with self.assertRaises(DomainError) as ctx:
            self.svc.sign_handover(self.case_id, 6)   # NKG
        self.assertEqual(ctx.exception.code, "WRONG_STATION")
        with self.assertRaises(DomainError) as ctx:
            self.svc.sign_handover(self.case_id, 7)   # CAN
        self.assertEqual(ctx.exception.code, "WRONG_STATION")
        # 本站 SHA 人员可以签收
        self.svc.sign_handover(self.case_id, 5)
        self.assertEqual(len(self.events()), 3)

    def test_ground_cannot_sign_at_arrival_station(self):
        # PEK 地面人员不能冒充到达站签收第3段(岗位+站点双重拦截)
        self.svc.sign_handover(self.case_id, 2)
        self.svc.sign_handover(self.case_id, 4)
        with self.assertRaises(DomainError) as ctx:
            self.svc.sign_handover(self.case_id, 3)   # PEK 地面
        self.assertEqual(ctx.exception.code, "WRONG_ROLE")

    def test_crew_not_bound_by_station(self):
        # 乘务组随机组流动, 第2段不受站点限制
        self.svc.sign_handover(self.case_id, 2)
        self.svc.sign_handover(self.case_id, 4)   # 乘务 station=NULL
        self.assertEqual(len(self.events()), 2)

    def test_pickup_station_enforced(self):
        self.sign_first_three()
        # NKG 到达人员不能在 SHA 办理领取
        with self.assertRaises(DomainError) as ctx:
            self.svc.pickup(self.case_id, self.active_code(),
                            "310110198202022222", 6)
        self.assertEqual(ctx.exception.code, "WRONG_STATION")

    def test_diversion_moves_signing_station(self):
        # 改降 NKG 后, 第3段只能在 NKG 签收; 原目的站 SHA 反而被拒
        self.svc.sign_handover(self.case_id, 2)
        self.svc.sign_handover(self.case_id, 4)
        self.svc.divert_flight("CA100", "2026-10-02", "NKG", "2026-10-02 12:30")
        with self.assertRaises(DomainError) as ctx:
            self.svc.sign_handover(self.case_id, 5)   # SHA 到达人员
        self.assertEqual(ctx.exception.code, "WRONG_STATION")
        self.svc.sign_handover(self.case_id, 6)       # NKG 到达人员
        self.assertEqual(self.events()[-1]["station"], "NKG")


if __name__ == "__main__":
    unittest.main()
