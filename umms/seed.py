"""演示种子数据: 站点/工作人员/航班/两个案例, 其中 MU5110 为改降样例。"""
import os

from .masks import generate_mask_image
from .service import UmService, mask_doc, mask_name

STAFF = [
    # (name, role, station)
    ("王琳", "counter", "PEK"),
    ("赵强", "ground", "PEK"),
    ("刘洋", "ground", "PEK"),
    ("陈静", "crew", None),          # 乘务组随机组流动
    ("孙悦", "crew", None),
    ("周敏", "arrival", "SHA"),
    ("吴磊", "arrival", "NKG"),      # 改降备降站到达人员
    ("郑华", "arrival", "CAN"),
]

FLIGHTS = [
    # (flight_no, date, origin, destination, dep, arr)
    ("CA1832", "2026-10-02", "PEK", "SHA", "2026-10-02 09:00", "2026-10-02 11:15"),
    ("MU5110", "2026-10-02", "PEK", "SHA", "2026-10-02 10:30", "2026-10-02 12:40"),
]


def seed(db, masks_dir="static/masks"):
    """幂等: 已有案例则跳过。"""
    conn = db.connect()
    try:
        if conn.execute("SELECT COUNT(*) AS c FROM cases").fetchone()["c"]:
            return False
    finally:
        conn.close()

    conn = db.connect()
    try:
        conn.executemany(
            "INSERT INTO staff (name, role, station) VALUES (?,?,?)", STAFF)
        conn.executemany(
            """INSERT INTO flights (flight_no, flight_date, origin, destination,
               sched_dep, sched_arr) VALUES (?,?,?,?,?,?)""", FLIGHTS)
        conn.commit()
    finally:
        conn.close()

    svc = UmService(db)

    # 案例一: 正常在途, 可从第1段开始完整走链
    case1 = dict(
        code="UM-7F3A", child_name="李小舟", child_age=9, child_gender="男",
        doc_type="居民身份证", doc_number="110105201703144321",
        care_notes="轻度晕机, 需靠窗座位; 随身背包内有晕车贴; 禁食花生。",
        sender_name="李建国", sender_phone="13801012233",
        sender_id_number="110105198801012233", sender_relation="父亲",
        receiver_name="李秀兰", receiver_phone="13911124455",
        receiver_id_number="310110198505054433", receiver_relation="祖母",
        flight_no="CA1832", flight_date="2026-10-02", seat="12A",
    )
    _create_with_mask(svc, case1, masks_dir)

    # 案例二: 改降样例 —— MU5110  PEK→SHA 改降 NKG, 已完成前两段
    case2 = dict(
        code="UM-9B2C", child_name="王思涵", child_age=7, child_gender="女",
        doc_type="户口簿", doc_number="110108201908087654",
        care_notes="哮喘史, 随身蓝色吸入器, 必要时协助使用; 情绪紧张时请乘务组安抚。",
        sender_name="王海涛", sender_phone="1370203000",   # 尾号000: 模拟短信不可达
        sender_id_number="110108198202023344", sender_relation="父亲",
        receiver_name="王美玲", receiver_phone="13655556677",
        receiver_id_number="320106198812126655", receiver_relation="母亲",
        flight_no="MU5110", flight_date="2026-10-02", seat="8C",
    )
    case2_id, _ = _create_with_mask(svc, case2, masks_dir)

    # 前两段在 PEK 完成签收
    svc.sign_handover(case2_id, staff_id=2, note="证件核验通过, 送机人已离场")   # 赵强 地面
    svc.sign_handover(case2_id, staff_id=4, note="已登机, 吸入器随身携带")       # 陈静 乘务

    # 改降样例: MU5110 改降南京禄口
    svc.divert_flight("MU5110", "2026-10-02", "NKG", "2026-10-02 13:05")
    return True


def _create_with_mask(svc, data, masks_dir):
    case_id, code = svc.create_case(data)
    rel = f"masks/{code}.svg"
    generate_mask_image(
        os.path.join(masks_dir, f"{code}.svg"),
        name_masked=mask_name(data["child_name"]), gender=data["child_gender"],
        age=data["child_age"], number_masked=mask_doc(data["doc_number"]),
        doc_type=data["doc_type"])
    conn = svc.db.connect()
    try:
        conn.execute("UPDATE cases SET doc_mask_image=? WHERE id=?", (rel, case_id))
        conn.commit()
    finally:
        conn.close()
    return case_id, code
