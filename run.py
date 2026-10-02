#!/usr/bin/env python3
"""一条命令启动: python3 run.py [--port 8000]

- 初始化 SQLite(交接链不可覆盖)
- 写入演示数据(含 MU5110 改降样例)
- 生成虚构证件遮罩图
- 启动本地服务
"""
import argparse
import os

from umms.db import Database
from umms.seed import seed
from umms.server import serve
from umms.service import UmService

BASE = os.path.dirname(os.path.abspath(__file__))


def main():
    parser = argparse.ArgumentParser(description="无成人陪伴儿童交接系统")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--db", default=os.path.join(BASE, "data", "umms.db"))
    args = parser.parse_args()

    os.makedirs(os.path.dirname(args.db), exist_ok=True)
    db = Database(args.db)
    if seed(db, masks_dir=os.path.join(BASE, "static", "masks")):
        print("已写入演示数据: CA1832 正常在途 / MU5110 改降南京(改降样例)")
    serve(UmService(db), port=args.port)


if __name__ == "__main__":
    main()
