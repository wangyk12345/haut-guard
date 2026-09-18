"""只读探测真实网关: 分别取一次**裸文本**与**命名字段(JSONP)**响应, 输出 JSON。

**本脚本不做任何登录/注销等写操作**, 只调用 rad_user_info 与 get_challenge,
因此不会改变校园网上的任何认证状态。

输出里同时包含:
  - named: 命名字段响应(权威语义, 深澜各固件位置布局不同, 命名不受影响)
  - status_parsed: Python 参考实现 query_status() 的结果(位置映射)

用法: python tools/live-check.py [gateway]
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from hautguard.srun_client import SrunClient  # noqa: E402

gateway = sys.argv[1] if len(sys.argv) > 1 else "172.16.154.130"
client = SrunClient(gateway=gateway, timeout=6)

out = {"gateway": gateway, "portal_url": client.portal_url, "status_url": client.status_url}

# ---- 裸文本(只读)
try:
    raw = client._get(client.status_url, timeout=6)
    out["status_raw"] = raw
    status = client.query_status()
    out["status_parsed"] = {
        "online": status.online,
        "user_name": status.user_name,
        "ip": status.ip,
        "sum_bytes": status.sum_bytes,
        "sum_seconds": status.sum_seconds,
        "add_time": status.add_time,
        "gateway_ver": status.gateway_ver,
    }
except Exception as exc:  # noqa: BLE001
    out["status_error"] = "%s: %s" % (type(exc).__name__, exc)

# ---- 命名字段(只读): 权威语义
try:
    named_raw = client._get(
        client.status_url, {"callback": "jsonp_livecheck"}, timeout=6
    )
    out["named_raw"] = named_raw
    body = named_raw.strip()
    if "(" in body and body.endswith(")"):
        body = body[body.index("(") + 1: body.rindex(")")]
    data = json.loads(body)
    out["named"] = {
        "user_name": data.get("user_name"),
        "ip": data.get("online_ip"),
        "add_time": data.get("add_time"),
        "keepalive_time": data.get("keepalive_time"),
        "bytes_in": data.get("bytes_in"),
        "bytes_out": data.get("bytes_out"),
        "sum_bytes": data.get("sum_bytes"),
        "sum_seconds": data.get("sum_seconds"),
        "user_balance": data.get("user_balance"),
        "sysver": data.get("sysver"),
    }
except Exception as exc:  # noqa: BLE001
    out["named_error"] = "%s: %s" % (type(exc).__name__, exc)

# ---- 令牌(只读)
try:
    ip = out.get("named", {}).get("ip") or out.get("status_parsed", {}).get("ip") or client.resolve_ip()
    token = client.get_token("probe", ip)
    out["challenge_ok"] = True
    out["token_len"] = len(token)
except Exception as exc:  # noqa: BLE001
    out["challenge_ok"] = False
    out["challenge_error"] = "%s: %s" % (type(exc).__name__, exc)

print(json.dumps(out, ensure_ascii=False))
