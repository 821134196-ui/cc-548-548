"""模拟适配器: 航班动态与短信网关。真实部署时替换为航信/运营商接口。"""


class FlightAdapter:
    """模拟航班信息系统: 延误、改降、到达。"""

    def __init__(self, db):
        self.db = db

    def get(self, flight_no, flight_date):
        conn = self.db.connect()
        try:
            row = conn.execute(
                "SELECT * FROM flights WHERE flight_no=? AND flight_date=?",
                (flight_no, flight_date),
            ).fetchone()
            return dict(row) if row else None
        finally:
            conn.close()

    def list_all(self):
        conn = self.db.connect()
        try:
            return [dict(r) for r in conn.execute(
                "SELECT * FROM flights ORDER BY flight_date, flight_no").fetchall()]
        finally:
            conn.close()

    def apply_delay(self, flight_no, flight_date, minutes, new_est_arr):
        conn = self.db.connect()
        try:
            conn.execute(
                "UPDATE flights SET status='DELAYED', est_arr=? "
                "WHERE flight_no=? AND flight_date=?",
                (new_est_arr, flight_no, flight_date))
            conn.commit()
        finally:
            conn.close()

    def apply_diversion(self, flight_no, flight_date, new_station, new_est_arr):
        conn = self.db.connect()
        try:
            conn.execute(
                "UPDATE flights SET status='DIVERTED', diverted_to=?, est_arr=? "
                "WHERE flight_no=? AND flight_date=?",
                (new_station, new_est_arr, flight_no, flight_date))
            conn.commit()
        finally:
            conn.close()


class SmsAdapter:
    """模拟短信网关: 发送结果写入 notifications 表(由 service 层落库)。

    演示规则: 手机号以 '000' 结尾时模拟发送失败(用于演示"联系不上家属"路径)。
    """

    def send(self, to_phone, body):
        if to_phone.endswith("000"):
            return {"ok": False, "error": "网关超时, 对方不可达"}
        return {"ok": True, "error": None}
