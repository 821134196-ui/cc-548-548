"""HTTP 服务: 纯标准库。JSON API + 静态文件。"""
import json
import os
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from .service import UmService, DomainError, EXCEPTION_TYPES, ROLE_NAMES

STATIC_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "static")

MIME = {".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml",
        ".png": "image/png", ".json": "application/json; charset=utf-8"}


def _gen_mask(service, case_id, code, data):
    """新登记案例即时生成虚构证件遮罩图。"""
    from .masks import generate_mask_image
    from .service import mask_doc, mask_name
    rel = f"masks/{code}.svg"
    generate_mask_image(
        os.path.join(STATIC_DIR, "masks", f"{code}.svg"),
        name_masked=mask_name(data["child_name"]), gender=data["child_gender"],
        age=data["child_age"], number_masked=mask_doc(data["doc_number"]),
        doc_type=data["doc_type"])
    conn = service.db.connect()
    try:
        conn.execute("UPDATE cases SET doc_mask_image=? WHERE id=?", (rel, case_id))
        conn.commit()
    finally:
        conn.close()


def make_handler(service):
    class Handler(BaseHTTPRequestHandler):
        server_version = "UMMS/1.0"

        # ---------- 基础 ----------
        def log_message(self, fmt, *args):  # 静音访问日志
            pass

        def _json(self, obj, status=200):
            body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _error(self, status, code, message):
            self._json({"error": code, "message": message}, status)

        def _body(self):
            length = int(self.headers.get("Content-Length") or 0)
            if not length:
                return {}
            try:
                return json.loads(self.rfile.read(length).decode("utf-8"))
            except json.JSONDecodeError:
                return {}

        def _query(self):
            from urllib.parse import urlparse, parse_qs
            qs = parse_qs(urlparse(self.path).query)
            return {k: v[0] for k, v in qs.items()}

        # ---------- 路由 ----------
        def do_GET(self):
            path = self.path.split("?")[0]
            try:
                if path == "/api/bootstrap":
                    return self._json({
                        "staff": service.list_staff(),
                        "flights": service.flights.list_all(),
                        "roles": ROLE_NAMES,
                        "exception_types": EXCEPTION_TYPES,
                    })
                if path == "/api/cases":
                    return self._json({"cases": service.list_cases()})
                m = re.fullmatch(r"/api/cases/(\d+)", path)
                if m:
                    role = self._query().get("role", "counter")
                    return self._json(service.case_detail(int(m.group(1)), role))
                if path == "/api/flights":
                    return self._json({"flights": service.flights.list_all()})
                return self._static(path)
            except DomainError as e:
                return self._error(404, e.code, e.message)

        def do_POST(self):
            path = self.path.split("?")[0]
            data = self._body()
            try:
                if path == "/api/cases":
                    case_id, code = service.create_case(data)
                    _gen_mask(service, case_id, code, data)
                    return self._json({"id": case_id, "code": code}, 201)
                m = re.fullmatch(r"/api/cases/(\d+)/(sign|exceptions|receiver|pickup|shift|notify-family)", path)
                if m:
                    return self._case_action(int(m.group(1)), m.group(2), data)
                m = re.fullmatch(r"/api/flights/([^/]+)/(delay|divert)", path)
                if m:
                    flight_no = m.group(1)
                    date = data.get("flight_date", "")
                    if m.group(2) == "delay":
                        r = service.delay_flight(flight_no, date, int(data.get("minutes", 0)))
                    else:
                        r = service.divert_flight(flight_no, date, data.get("station", ""),
                                                  data.get("est_arr"))
                    return self._json(r)
                return self._error(404, "NOT_FOUND", "接口不存在")
            except DomainError as e:
                status = 409 if e.code in (
                    "NOT_READY", "ALREADY_COMPLETED", "AUTH_REVOKED", "AUTH_USED",
                    "AUTH_INVALID", "DOC_MISMATCH", "WRONG_ROLE", "WRONG_STATION",
                    "STAFF_OFF_DUTY", "USE_PICKUP", "NO_ACTIVE_CODE") else 400
                return self._error(status, e.code, e.message)

        def _case_action(self, case_id, action, data):
            if action == "sign":
                return self._json(service.sign_handover(
                    case_id, int(data.get("staff_id", 0)), data.get("note", "")), 201)
            if action == "exceptions":
                exc_id = service.report_exception(
                    case_id, data.get("type", ""), data.get("detail", ""),
                    data.get("staff_id"))
                return self._json({"id": exc_id}, 201)
            if action == "receiver":
                return self._json(service.change_receiver(
                    case_id, data.get("receiver", {}), data.get("reason", ""),
                    int(data.get("staff_id", 0))))
            if action == "pickup":
                return self._json(service.pickup(
                    case_id, data.get("auth_code", ""), data.get("doc_number", ""),
                    int(data.get("staff_id", 0))), 201)
            if action == "shift":
                return self._json(service.shift_change(
                    case_id, int(data.get("new_staff_id", 0)),
                    data.get("reason", ""), int(data.get("staff_id", 0))))
            if action == "notify-family":
                service.retry_notify_family(case_id, data.get("staff_id"))
                return self._json({"ok": True})

        def _static(self, path):
            if path in ("/", "/index.html"):
                path = "/index.html"
            # 防目录穿越
            safe = os.path.normpath(path).lstrip("/")
            full = os.path.join(STATIC_DIR, safe)
            if not full.startswith(STATIC_DIR) or not os.path.isfile(full):
                return self._error(404, "NOT_FOUND", "资源不存在")
            ext = os.path.splitext(full)[1]
            with open(full, "rb") as f:
                body = f.read()
            self.send_response(200)
            self.send_header("Content-Type", MIME.get(ext, "application/octet-stream"))
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    return Handler


def serve(service, host="127.0.0.1", port=8000):
    httpd = ThreadingHTTPServer((host, port), make_handler(service))
    print(f"UM 交接系统已启动:  http://{host}:{port}")
    print("按 Ctrl+C 停止。")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
