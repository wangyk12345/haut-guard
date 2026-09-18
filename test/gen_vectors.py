#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""gen_vectors.py —— 从 Python 参考实现导出对拍向量。

把 hautguard/srun_client.py 的纯函数在一大批输入上的输出固化成 vectors.json,
供 JavaScript 移植版逐条比对 (Node 侧读同一个文件比对)。

用法 (工作目录 = hautguard-app/test):
    python gen_vectors.py            # 生成 test/vectors.json
    python gen_vectors.py out.json   # 指定输出文件

约束:
  * 只导入参考实现, 不修改它;
  * 固定随机种子 random.seed(20240918), 输出可复现;
  * 任一输入只要参考实现抛异常, 就原样记录成 {"error": "<类型>: <消息>"}, 绝不跳过。

输出结构 (与 JS 测试约定, 不要改字段名):
{
  "meta": {"python_version": "3.10.6", "seed": 20240918,
           "generated_by": "gen_vectors.py", "counts": {"xencode": N, ...}, "command": "..."},
  "cases": [
    {"fn": "xencode",             "args": [msg, key],                              "expected": "..."},
    {"fn": "b64_srun",            "input_hex": "...",                              "expected": "..."},
    {"fn": "make_password_field", "args": [token, password, algo],                 "expected": ["字段", "hmd5"]},
    {"fn": "make_info_field",     "args": [username, password, ip, token, fmt],    "expected": "..."},
    {"fn": "make_chksum",         "args": [token, username, hmd5, ip, info],       "expected": "..."}
  ]
}
"""
from __future__ import annotations

import json
import os
import platform
import random
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

from hautguard.srun_client import (  # noqa: E402  (必须在 sys.path 调整之后导入)
    b64_srun,
    make_chksum,
    make_info_field,
    make_password_field,
    xencode,
)

SEED = 20240918
GENERATED_BY = "gen_vectors.py"
GENERATION_COMMAND = "cd hautguard-app/test && python gen_vectors.py"

ALGOS = ("srun3", "srbx1")
FORMATS = ("srun3", "srbx1", "none")

# 覆盖 xencode 的输入字符池 (注意: 参考实现按 ord() 取码点, 非 latin-1 字符行为特殊)
ASCII_POOL = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
PUNCT_POOL = "!@#$%^&*()_+-=[]{}|;:',.<>/?`~\"\\ "
CJK_POOL = "深澜校园网认证测试用户名密码"
EMOJI_POOL = "😀🎉🚀中"


def rand_text(rnd: random.Random, n: int, pool: str) -> str:
    return "".join(rnd.choice(pool) for _ in range(n))


def rand_hex(rnd: random.Random, n: int) -> str:
    return "".join(rnd.choice("0123456789abcdef") for _ in range(n))


def hexs(data: bytes) -> str:
    return data.hex()


def json_safe(value):
    """把只用于记录的值转成 JSON 可表达的形式 (bytes 之类)。"""
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    if isinstance(value, (list, tuple)):
        return [json_safe(v) for v in value]
    if isinstance(value, dict):
        return {str(k): json_safe(v) for k, v in value.items()}
    if isinstance(value, (bytes, bytearray)):
        return {"__type__": "bytes", "hex": value.hex()}
    return {"__type__": type(value).__name__, "repr": repr(value)}


def add(cases, fn, args, fn_obj, *, label="", input_hex=None, hex_input=False):
    """调用参考实现并把结果/异常记录成一条用例。"""
    case = {"fn": fn}
    if label:
        case["note"] = label
    if hex_input:
        case["input_hex"] = args
        call_args = (bytes.fromhex(args),)
    else:
        case["args"] = json_safe(args)
        call_args = tuple(args)
    try:
        value = fn_obj(*call_args)
    except BaseException as exc:  # noqa: BLE001 —— 除 KeyboardInterrupt 外的一切都如实记录
        # 异常类型 + 消息, 例如 "TypeError: object of type 'int' has no len()"
        case["error"] = f"{type(exc).__name__}: {exc}"
        cases.append(case)
        return
    if isinstance(value, tuple):
        value = list(value)
    case["expected"] = json_safe(value)
    cases.append(case)


def build_xencode(rnd: random.Random):
    cases = []
    keys = ["", "k", "key", "key0", "0123456789abcdef", rand_text(rnd, 16, ASCII_POOL),
            "test", "1"]

    # 1) 长度边界: 空串 / 1..5 / 7,8 / 15,16,17
    fixed_msgs = [
        "", "a", "ab", "abc", "abcd", "abcde", "abcdefg", "abcdefgh",
        "a" * 15, "a" * 16, "a" * 17,
        "hello world", "0", "00", "000", "0000", "The quick brown fox jumps over the lazy dog",
        "p@ssw0rd!@#$%^&*()", "深", "深澜", "深澜校园网", "深澜校园网认证客户端测试",
        "中文与emoji混排😀🎉", "😀", "😀😀😀😀", "🚀" * 8, "深澜😀test123",
        "a" * 63, "a" * 64, "a" * 65,
    ]
    for msg in fixed_msgs:
        for key in keys[:5]:
            add(cases, "xencode", [msg, key], xencode)

    # 2) key 长度 0/1/3/4/5/16 全覆盖
    for key_len in (0, 1, 2, 3, 4, 5, 16, 17):
        for msg in ("hello", "深澜校园网", "x" * 19):
            add(cases, "xencode", [msg, "k" * key_len], xencode)

    # 3) 长消息 > 2000 字符
    for n in (2001, 2048, 2500, 3000, 4096):
        msg = rand_text(rnd, n, ASCII_POOL + PUNCT_POOL)
        add(cases, "xencode", [msg, rand_text(rnd, 8, ASCII_POOL)], xencode,
            label=f"长消息 {n} 字符")
    add(cases, "xencode", ["深" * 2200, "token-深澜"], xencode, label="长中文消息 2200 字符")
    add(cases, "xencode", ["😀" * 1100, "key"], xencode, label="长 emoji 消息 1100 码点")

    # 4) 随机补充到 ~600 条
    pools = [ASCII_POOL, ASCII_POOL + PUNCT_POOL, CJK_POOL, ASCII_POOL + CJK_POOL,
             ASCII_POOL + CJK_POOL + EMOJI_POOL]
    while len(cases) < 600:
        pool = rnd.choice(pools)
        msg = rand_text(rnd, rnd.randint(0, 40), pool)
        key = rand_text(rnd, rnd.randint(0, 20), rnd.choice(pools[:3]))
        add(cases, "xencode", [msg, key], xencode)

    # 5) 非字符串输入 -> 参考实现会抛异常, 如实记录
    add(cases, "xencode", [None, "key"], xencode, label="msg=None")
    add(cases, "xencode", [12345, "key"], xencode, label="msg=int")
    add(cases, "xencode", ["hello", None], xencode, label="key=None")
    add(cases, "xencode", ["hello", 12345], xencode, label="key=int")
    add(cases, "xencode", [True, "key"], xencode, label="msg=bool")
    add(cases, "xencode", [b"bytes", "key"], xencode, label="msg=bytes")
    return cases


def build_b64(rnd: random.Random):
    cases = []
    # 0..300 全部长度: 覆盖 = 填充与 + / 出现的各种边界
    for n in range(0, 301):
        data = bytes(rnd.randrange(256) for _ in range(n))
        add(cases, "b64_srun", hexs(data), b64_srun, input_hex=True, hex_input=True,
            label=f"随机 {n} 字节")
    # 刻意制造 + / = 的字节
    for n in (1, 2, 3, 4, 5, 6, 7, 8):
        for byte in (0x00, 0x3E, 0x3F, 0xFB, 0xEF, 0xBE, 0xFF, 0xFE, 0xAA, 0xF0):
            add(cases, "b64_srun", hexs(bytes([byte]) * n), b64_srun, input_hex=True,
                hex_input=True, label=f"0x{byte:02x} x{n}")
    # 随机补齐到 ~600
    while len(cases) < 600:
        n = rnd.randint(0, 512)
        data = bytes(rnd.randrange(256) for _ in range(n))
        add(cases, "b64_srun", hexs(data), b64_srun, input_hex=True, hex_input=True,
            label=f"随机 {n} 字节")
    return cases


def build_password(rnd: random.Random):
    cases = []
    pools = [ASCII_POOL, ASCII_POOL + PUNCT_POOL, ASCII_POOL + CJK_POOL]
    for algo in ALGOS:
        for _ in range(250):
            token = rand_hex(rnd, rnd.choice([32, 40, 64]))
            pwd = rand_text(rnd, rnd.randint(1, 24), rnd.choice(pools))
            add(cases, "make_password_field", [token, pwd, algo], make_password_field)
        # 边界
        add(cases, "make_password_field", ["", "", algo], make_password_field, label="空 token/空密码")
        add(cases, "make_password_field", ["t" * 200, "p" * 200, algo], make_password_field,
            label="超长 token/密码")
        add(cases, "make_password_field", ["token", "深澜密码😀", algo], make_password_field,
            label="中文+emoji 密码")
    return cases


def build_info(rnd: random.Random):
    cases = []
    pools = [ASCII_POOL, ASCII_POOL + PUNCT_POOL, ASCII_POOL + CJK_POOL]
    for fmt in FORMATS:
        for _ in range(200):
            username = rand_text(rnd, rnd.randint(1, 12), ASCII_POOL)
            pwd = rand_text(rnd, rnd.randint(1, 20), rnd.choice(pools))
            ip = ".".join(str(rnd.randint(1, 254)) for _ in range(4))
            token = rand_hex(rnd, rnd.choice([32, 40, 64]))
            add(cases, "make_info_field", [username, pwd, ip, token, fmt], make_info_field)
        add(cases, "make_info_field", ["20230001", "中文密码😀", "192.168.1.2", "deadbeef" * 8, fmt],
            make_info_field, label="中文+emoji 密码")
        add(cases, "make_info_field", ["u", "", "0.0.0.0", "k", fmt], make_info_field,
            label="空密码")
    return cases


def build_chksum(rnd: random.Random):
    cases = []
    for _ in range(300):
        token = rand_hex(rnd, rnd.choice([32, 40, 64]))
        username = rand_text(rnd, rnd.randint(1, 12), ASCII_POOL)
        hmd5 = rand_hex(rnd, 32)
        ip = ".".join(str(rnd.randint(1, 254)) for _ in range(4))
        info = "{SRUN3}\r\n" + rand_text(rnd, rnd.randint(0, 60), ASCII_POOL + "+/=")
        add(cases, "make_chksum", [token, username, hmd5, ip, info], make_chksum)
    add(cases, "make_chksum", ["", "", "", "", ""], make_chksum, label="全空")
    add(cases, "make_chksum", ["t", "u", "h", "1.2.3.4", "{SRBX1}AAA="], make_chksum,
        label="最短输入")
    add(cases, "make_chksum", [None, "u", "h", "1.2.3.4", "i"], make_chksum, label="token=None")
    return cases


def main() -> int:
    out_path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "vectors.json")

    random.seed(SEED)          # 硬性要求: 固定种子
    rnd = random.Random(SEED)  # 独立实例, 避免与上面共享状态互相干扰
    cases = []
    cases += build_xencode(rnd)
    cases += build_b64(rnd)
    cases += build_password(rnd)
    cases += build_info(rnd)
    cases += build_chksum(rnd)

    counts = {}
    for c in cases:
        counts[c["fn"]] = counts.get(c["fn"], 0) + 1

    doc = {
        "meta": {
            "python_version": platform.python_version(),
            "seed": SEED,
            "generated_by": GENERATED_BY,
            "counts": counts,
            "command": GENERATION_COMMAND,
            "reference": "hautguard/srun_client.py",
            "total": len(cases),
            "error_cases": sum(1 for c in cases if "error" in c),
        },
        "cases": cases,
    }

    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=False, indent=1)
        fh.write("\n")

    size = os.path.getsize(out_path)
    print(f"[gen_vectors] 已生成 {out_path} ({size} 字节, {len(cases)} 条用例)")
    print(f"[gen_vectors] python_version={doc['meta']['python_version']} seed={SEED}")
    for fn in ("xencode", "b64_srun", "make_password_field", "make_info_field", "make_chksum"):
        print(f"[gen_vectors]   {fn:<20} {counts.get(fn, 0):>5}")
    print(f"[gen_vectors]   {'异常用例':<20} {doc['meta']['error_cases']:>5}")
    if len(cases) < 2000:
        print("[gen_vectors] 错误: 用例数不足 2000", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
