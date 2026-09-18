#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""integration_python.py —— 用 Python 参考实现打通 mock-gateway.js。

目的: 在写 JS 版协议实现之前, 先用**已经逐字节验证过的 Python 参考实现**跑通模拟网关,
     从而证明"网关侧校验逻辑"与"客户端侧加密逻辑"这一对是自洽的。之后 JS 移植版
     只要对着同一套 mock + vectors.json 对齐即可。

用法 (工作目录 = hautguard-app/test):
    python integration_python.py            # 全部场景, 通过则退出码 0
    python integration_python.py --verbose  # 额外打印 mock 的完整请求日志

关于 URL 的适配 (重要):
    参考实现把 portal 放在 `http://<gw>:<portal_port>/cgi-bin/srun_portal`, 而 status 与
    challenge 是 `http://<gw>/cgi-bin/...`(**不带端口**) —— 真实网关上这是 80 端口。
    本 mock 只监听一个端口, 所以测试里用子类覆写 status_url / challenge_url 把端口带上。
    这是测试侧适配, **没有修改 hautguard/srun_client.py**。

固定夹具 (与 JS 侧对拍约定, 见 mock-gateway.js 的 DEFAULT_ACCOUNTS / DEFAULT_STATUS_TEXT):
    20230001/correct-horse 登录成功; 20230002/battery-staple 密码比对;
    disabled->E2532 locked->E2553 elsewhere-ip->E2601 elsewhere-account->E2602
    lowbalance->E2611 arrears->E2612 suspended->E2613 already->E2620 nobody->E6512
    未列出的用户名 -> E2531; 固定 token = "test-token-0001"
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

from hautguard.srun_client import (  # noqa: E402
    AC_ID, ERROR_MESSAGES, N, TYPE,
    SrunClient, SrunError,
    make_chksum, make_info_field, make_password_field,
)

MOCK_JS = os.path.join(HERE, "mock-gateway.js")
PORTAL_JS = os.path.join(REPO_ROOT, "tools", "gateway_js", "jquery.srun.portal.js")

# ---- 跨语言对拍的固定夹具 ----
FIXED_TOKEN = "test-token-0001"
OK_USER, OK_PWD = "20230001", "correct-horse"
OK2_USER, OK2_PWD = "20230002", "battery-staple"
STATUS_TEXT = "20230001,1758000000,1758002849,320253309,51417663,0,132329343471,644217,10.20.30.40,0,,20,0,0,0,0,0,0,0,0,1.01.20180614"
ONLINE_IP = "10.20.30.40"
GATEWAY_VERSION = "1.01.20180614"

# 真实网关前端 (tools/gateway_js/jquery.srun.portal.js) 里各请求携带的参数名
PORTAL_LOGIN_KEYS = {"action", "username", "password", "ac_id", "ip", "chksum", "info",
                     "n", "type", "os", "name", "double_stack"}
PORTAL_LOGOUT_KEYS = {"action", "username", "ac_id", "ip"}
CHALLENGE_KEYS = {"username", "ip"}


# ------------------------------------------------------------------ 测试脚手架

class Report:
    def __init__(self):
        self.passed = 0
        self.failed = 0
        self.rows = []

    def check(self, name, cond, detail=""):
        if cond:
            self.passed += 1
            self.rows.append((True, name, detail))
            print(f"  [PASS] {name}" + (f"  {detail}" if detail else ""))
        else:
            self.failed += 1
            self.rows.append((False, name, detail))
            print(f"  [FAIL] {name}  {detail}")
        return bool(cond)

    def eq(self, name, got, want):
        return self.check(name, got == want, f"got={got!r} want={want!r}")


def section(title):
    print()
    print("=" * 78)
    print(title)
    print("=" * 78)


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def http_get(url, params=None, timeout=6):
    """裸 HTTP GET, 返回 (status, text)。"""
    if params:
        url = f"{url}?{urllib.parse.urlencode(params, quote_via=urllib.parse.quote)}"
    req = urllib.request.Request(url, headers={"User-Agent": "integration-python"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode("utf-8", "replace")


def jsonp_body(text):
    body = text.strip()
    if "(" in body and body.rstrip().endswith(")"):
        body = body[body.index("(") + 1: body.rindex(")")]
    return json.loads(body)


class MockGateway:
    """以子进程方式启动 mock-gateway.js, 等端口就绪。"""

    def __init__(self, fixtures=None, fail_mode=None, password_algo=None,
                 info_format=None, token=FIXED_TOKEN, quiet=True):
        self.tmp = tempfile.mkdtemp(prefix="mockgw-")
        self.port = free_port()
        self.url = f"http://127.0.0.1:{self.port}"
        self.log_json = os.path.join(self.tmp, "requests.jsonl")
        self.stdout_path = os.path.join(self.tmp, "stdout.log")
        self.stderr_path = os.path.join(self.tmp, "stderr.log")
        self.fixtures_path = os.path.join(self.tmp, "fixtures.json")
        self.fixtures = fixtures or {}
        self.fail_mode = fail_mode
        self.password_algo = password_algo
        self.info_format = info_format
        self.token = token
        self.quiet = quiet
        self.proc = None
        self._out = None
        self._err = None

    def start(self, ready_timeout=20.0):
        with open(self.fixtures_path, "w", encoding="utf-8") as fh:
            json.dump(self.fixtures, fh, ensure_ascii=False)
        cmd = [shutil.which("node") or "node", MOCK_JS,
               "--port", str(self.port),
               "--fixtures", self.fixtures_path,
               "--log-json", self.log_json]
        if self.token:
            cmd += ["--token", self.token]
        if self.fail_mode:
            cmd += ["--fail-mode", self.fail_mode]
        if self.password_algo:
            cmd += ["--password-algo", self.password_algo]
        if self.info_format:
            cmd += ["--info-format", self.info_format]
        if self.quiet:
            cmd += ["--quiet"]
        self._out = open(self.stdout_path, "wb")
        self._err = open(self.stderr_path, "wb")
        self.proc = subprocess.Popen(cmd, stdout=self._out, stderr=self._err, cwd=HERE)
        deadline = time.time() + ready_timeout
        last = ""
        while time.time() < deadline:
            if self.proc.poll() is not None:
                raise RuntimeError(
                    f"mock 进程提前退出 (code={self.proc.returncode}):\n{self.read_stderr()}")
            try:
                # 用控制面探活: 故障注入(refuse/timeout)时业务端点不可用, 但 /__mock__/state 永远可用
                status, text = http_get(f"{self.url}/__mock__/state", timeout=1)
                if status == 200 and json.loads(text).get("ok"):
                    return self
                last = f"HTTP {status}: {text[:80]}"
            except (OSError, ValueError) as exc:
                last = str(exc)
            time.sleep(0.1)
        raise RuntimeError(f"mock 在 {ready_timeout}s 内未就绪 (最后错误: {last})")

    def read_stdout(self):
        try:
            with open(self.stdout_path, "r", encoding="utf-8", errors="replace") as fh:
                return fh.read()
        except OSError:
            return ""

    def read_stderr(self):
        try:
            with open(self.stderr_path, "r", encoding="utf-8", errors="replace") as fh:
                return fh.read()
        except OSError:
            return ""

    def requests(self):
        out = []
        try:
            with open(self.log_json, "r", encoding="utf-8") as fh:
                for line in fh:
                    line = line.strip()
                    if line:
                        out.append(json.loads(line))
        except OSError:
            pass
        return out

    def client(self, timeout=8):
        return MockClient(gateway="127.0.0.1", portal_port=self.port, timeout=timeout)

    def challenge(self, username, ip):
        _, text = http_get(f"{self.url}/cgi-bin/get_challenge",
                           {"callback": "cb", "username": username, "ip": ip})
        return jsonp_body(text)["challenge"]

    def portal(self, params):
        return http_get(f"{self.url}/cgi-bin/srun_portal", params)

    def set_scenario(self, patch):
        req = urllib.request.Request(f"{self.url}/__mock__/scenario", method="POST",
                                     data=json.dumps(patch).encode(),
                                     headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=5) as resp:
                return bool(json.loads(resp.read().decode()).get("ok"))
        except (urllib.error.URLError, OSError, ValueError):
            return False

    def close(self):
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait(timeout=5)
        for fh in (self._out, self._err):
            try:
                if fh:
                    fh.close()
            except OSError:
                pass
        return self.tmp


class MockClient(SrunClient):
    """测试侧适配: 把 status/challenge 也指向 mock 的单端口。

    参考实现的这两个属性不带端口(真实网关由 80 端口提供), 这里覆写属性,
    不触碰 hautguard/srun_client.py 的任何代码。
    """

    @property
    def status_url(self) -> str:
        return f"{self.base}:{self._portal_port}/cgi-bin/rad_user_info"

    @property
    def challenge_url(self) -> str:
        return f"{self.base}:{self._portal_port}/cgi-bin/get_challenge"


class ctx_gateway:
    """with ctx_gateway(fixtures=...) as gw: ..."""

    def __init__(self, **kwargs):
        self.kwargs = kwargs
        self.gw = None

    def __enter__(self):
        self.gw = MockGateway(**self.kwargs)
        self.gw.start()
        return self.gw

    def __exit__(self, *exc):
        tmp = self.gw.close()
        shutil.rmtree(tmp, ignore_errors=True)
        return False


def mock_exported_status_text():
    """从 mock 导出里取约定的状态串原文, 用于和本文件的字面量对拍。"""
    try:
        proc = subprocess.run(
            [shutil.which("node") or "node", "-e",
             "console.log(require('./mock-gateway').DEFAULT_STATUS_TEXT)"],
            cwd=HERE, capture_output=True, text=True, timeout=20)
        return proc.stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return ""


# ------------------------------------------------------------------ 场景

def scenario_fixture_contract(rep: Report):
    section("场景 0: 固定夹具契约 (mock 导出的 DEFAULT_STATUS_TEXT 与 Python 侧约定一致)")
    exported = mock_exported_status_text()
    print(f"  mock 导出: {exported!r}")
    print(f"  Python 约定: {STATUS_TEXT!r}")
    rep.eq("DEFAULT_STATUS_TEXT 一致", exported, STATUS_TEXT)
    rep.eq("ERROR_MESSAGES[E2531]", ERROR_MESSAGES["E2531"], "账号或密码错误")
    rep.eq("ERROR_MESSAGES[E2612]", ERROR_MESSAGES["E2612"], "账号已欠费")


def scenario_status(rep: Report):
    section("场景 1: rad_user_info 在线/离线 (与固定夹具逐位对比)")
    # 1a) 全新 mock 离线
    with ctx_gateway(fixtures={"onlineSessions": []}) as gw:
        status, text = http_get(f"{gw.url}/cgi-bin/rad_user_info")
        print(f"  离线响应原文: HTTP {status} {text!r}")
        rep.eq("离线裸文本", text.strip(), "not_online_error")
        st = gw.client().query_status(force=True)
        rep.eq("离线 online", st.online, False)
        rep.eq("离线 error", st.error, "not_online_error")

    # 1b) 20230001 登录成功后 -> 状态串必须逐字节等于固定夹具
    with ctx_gateway(fixtures={"onlineSessions": []}) as gw:
        client = gw.client()
        res = client.login(OK_USER, OK_PWD, ip=ONLINE_IP)
        rep.check("登录成功后进入在线态", res.ok, f"message={res.message!r}")
        status, text = http_get(f"{gw.url}/cgi-bin/rad_user_info")
        print(f"  在线响应原文: HTTP {status} {text!r}")
        rep.eq("在线裸文本 == DEFAULT_STATUS_TEXT", text.strip(), STATUS_TEXT)
        st = client.query_status(force=True)
        rep.eq("st.user_name", st.user_name, "20230001")
        rep.eq("st.add_time", st.add_time, 1758000000)
        rep.eq("st.sum_bytes(账号累计)", st.sum_bytes, 132329343471)
        rep.eq("st.sum_seconds(账号累计)", st.sum_seconds, 644217)
        rep.eq("st.ip", st.ip, ONLINE_IP)
        rep.eq("st.gateway_ver", st.gateway_ver, GATEWAY_VERSION)
        rep.eq("st.bytes_text", st.bytes_text, "123.24 GB")
        rep.eq("st.duration_text", st.duration_text, "7 天 10 小时 56 分")

    # 1c) 预置在线会话 (options.onlineSessions) 也能被识别
    with ctx_gateway(fixtures={"onlineSessions": [
        {"username": OK_USER, "ip": "172.20.0.9"}
    ]}) as gw:
        st = gw.client().query_status(force=True)
        rep.check("预置会话时 online=True", st.online, f"online={st.online}")
        rep.eq("预置会话 user_name", st.user_name, "20230001")
        rep.eq("预置会话 ip(取预置值)", st.ip, "172.20.0.9")
        rep.eq("预置会话 sum_bytes(取 canonical 值)", st.sum_bytes, 132329343471)
        rep.eq("预置会话 sum_seconds(取 canonical 值)", st.sum_seconds, 644217)


def scenario_login(rep: Report):
    section("场景 2: 登录分支 (固定账号夹具)")
    # 2a) 20230002 先写错密码 -> E2531, 再用正确密码 -> 成功
    with ctx_gateway(fixtures={"onlineSessions": []}) as gw:
        client = gw.client()
        bad = client.login(OK2_USER, "definitely-wrong", ip="192.168.66.12")
        print(f"  · 20230002 错误密码: ok={bad.ok} code={bad.code!r} message={bad.message!r}")
        rep.eq("20230002 错误密码 ok", bad.ok, False)
        rep.eq("20230002 错误密码 code", bad.code, "E2531")
        rep.eq("20230002 错误密码 message", bad.message, "账号或密码错误")
        good = client.login(OK2_USER, OK2_PWD, ip="192.168.66.12")
        print(f"  · 20230002 正确密码: ok={good.ok} message={good.message!r}")
        rep.eq("20230002 正确密码 ok", good.ok, True)

    # 2b) 错误码表 (这些账号都不会真的上线, 所以可以共用一个 mock)
    table = [
        ("disabled", "E2532", "账号被禁用"),
        ("locked", "E2553", "密码错误次数过多，账号被暂时锁定"),
        ("elsewhere-ip", "E2601", "本机 IP 已在别处登录"),
        ("elsewhere-account", "E2602", "账号已在别处登录"),
        ("lowbalance", "E2611", "账号余额不足"),
        ("arrears", "E2612", "账号已欠费"),
        ("suspended", "E2613", "账号已停机"),
        ("already", "E2620", "本机已在线，无需重复登录"),
        ("nobody", "E6512", "账号未注册或不存在"),
    ]
    with ctx_gateway(fixtures={"onlineSessions": []}) as gw:
        for idx, (user, code, msg) in enumerate(table):
            ip = f"192.168.67.{10 + idx}"
            try:
                res = gw.client().login(user, "x", ip=ip)
                print(f"  · {user:<18} -> ok={res.ok} already_online={res.already_online} "
                      f"code={res.code!r} message={res.message!r}")
                rep.eq(f"{user} code", res.code, code)
                rep.eq(f"{user} message", res.message, msg)
                expected_ok = code in ("E2601", "E2602", "E2620")
                rep.eq(f"{user} ok", res.ok, expected_ok)
                rep.eq(f"{user} already_online", res.already_online, expected_ok)
            except SrunError as exc:
                rep.check(f"{user} 登录", False, f"抛出 SrunError: {exc} (kind={exc.kind})")

    # 2c) 未列出的用户名 -> E2531
    with ctx_gateway(fixtures={"onlineSessions": []}) as gw:
        res = gw.client().login("not-in-fixture", "whatever", ip="192.168.67.99")
        rep.eq("未列出用户名 code", res.code, "E2531")
        rep.eq("未列出用户名 message", res.message, "账号或密码错误")

    # 2d) 自定义账号夹具: 中文密码 / E3002 / E3101
    custom = [
        {"username": "cn-user", "password": "p@ss中文😀", "status": "ok"},
        {"username": "e3002user", "password": "x", "status": "E3002", "forceError": True},
        {"username": "e3101user", "password": "x", "status": "E3101", "forceError": True},
    ]
    with ctx_gateway(fixtures={"accounts": custom, "onlineSessions": []}) as gw:
        res = gw.client().login("cn-user", "p@ss中文😀", ip="192.168.68.1")
        rep.check("自定义夹具(中文+emoji 密码)登录成功", res.ok, f"code={res.code!r} message={res.message!r}")
        r2 = gw.client().login("e3002user", "x", ip="192.168.68.2")
        rep.eq("自定义夹具 E3002 message", r2.message, "认证参数错误")
        r3 = gw.client().login("e3101user", "x", ip="192.168.68.3")
        rep.eq("自定义夹具 E3101 message", r3.message, "网关内部错误")

    # 2e) 网关级强制错误 (setScenario.forcePortalError), 不依赖账号夹具
    with ctx_gateway(fixtures={"onlineSessions": []}) as gw:
        for code, msg in (("E3002", "认证参数错误"), ("E3101", "网关内部错误")):
            gw.set_scenario({"forcePortalError": code})
            res = gw.client().login(OK_USER, OK_PWD, ip="192.168.68.9")
            rep.eq(f"forcePortalError={code} -> message", res.message, msg)
        gw.set_scenario({"forcePortalError": None})


def scenario_logout(rep: Report):
    section("场景 3: 注销 / 重复注销")
    with ctx_gateway(fixtures={"onlineSessions": []}) as gw:
        client = gw.client()
        res = client.login(OK_USER, OK_PWD, ip=ONLINE_IP)
        rep.check("注销前登录成功", res.ok, f"message={res.message!r}")
        st = client.query_status()
        rep.check("注销前在线", st.online and st.user_name == OK_USER,
                  f"online={st.online} user_name={st.user_name!r}")
        ok, msg = client.logout(OK_USER)
        print(f"  · logout -> ({ok}, {msg!r})")
        rep.eq("logout().ok", ok, True)
        rep.eq("logout().message", msg, "已退出网络连接")
        st2 = client.query_status()
        rep.eq("注销后离线", st2.online, False)
        ok2, msg2 = client.logout(OK_USER)
        print(f"  · 重复 logout -> ({ok2}, {msg2!r})")
        rep.eq("重复注销仍算成功", ok2, True)
        rep.eq("重复注销文案", msg2, "当前本就未在线")


def scenario_tamper(rep: Report):
    section("场景 4: 伪造 chksum / 篡改 info / 重放 token 必须被网关拒绝")
    with ctx_gateway(fixtures={"onlineSessions": []}) as gw:
        def login_raw(username, ip, password, *, token=None, fetch=True,
                      chksum_override=None, info_override=None, hmd5_override=None):
            if fetch:
                token = gw.challenge(username, ip)
            pwd_field, hmd5 = make_password_field(token, password)
            info = make_info_field(username, password, ip, token)
            if info_override is not None:
                info = info_override
            use_hmd5 = hmd5 if hmd5_override is None else hmd5_override
            params = {
                "callback": "cb", "action": "login", "username": username,
                "password": "{" + use_hmd5 + "}", "ac_id": AC_ID, "ip": ip, "info": info,
                "chksum": make_chksum(token, username, use_hmd5, ip, info),
                "n": N, "type": TYPE, "os": "Windows 10", "name": "Windows",
                "double_stack": "0",
            }
            if chksum_override is not None:
                params["chksum"] = chksum_override
            _, text = gw.portal(params)
            return text

        # 4a) 对照组: 正确构造必须成功
        text = login_raw(OK_USER, "192.168.70.1", OK_PWD)
        body = jsonp_body(text)
        print(f"  · 对照组(正确签名): {text!r}")
        rep.check("对照组正确签名被接受",
                  body.get("error") == "ok" and body.get("ecode") in (0, "0"), f"body={body}")

        # 4b) 伪造 chksum
        text = login_raw(OK_USER, "192.168.70.2", OK_PWD, chksum_override="0" * 40)
        body = jsonp_body(text)
        print(f"  · 伪造 chksum: {text!r}")
        rep.check("伪造 chksum 被拒 (E3005)",
                  body.get("error") == "E3005" and body.get("ecode") == 1, f"body={body}")

        # 4c) 篡改 info: 换成用别的 token 加密的 info, chksum 按篡改后的 info 正确计算
        tok = gw.challenge(OK_USER, "192.168.70.3")
        forged = make_info_field(OK_USER, OK_PWD, "192.168.70.3", "00000000" * 4)
        text = login_raw(OK_USER, "192.168.70.3", OK_PWD, token=tok, fetch=False,
                         info_override=forged)
        body = jsonp_body(text)
        print(f"  · 篡改 info(换 token 加密): {text!r}")
        rep.check("篡改 info 被拒 (E3005)", body.get("error") == "E3005", f"body={body}")

        # 4d) 篡改 info 里的 ip (chksum 仍然自洽) -> 解密成功但字段不一致
        tok = gw.challenge(OK_USER, "192.168.70.4")
        mismatched = make_info_field(OK_USER, OK_PWD, "10.0.0.99", tok)
        text = login_raw(OK_USER, "192.168.70.4", OK_PWD, token=tok, fetch=False,
                         info_override=mismatched)
        body = jsonp_body(text)
        print(f"  · 篡改 info(ip 不一致): {text!r}")
        rep.check("info 字段不一致被拒 (E3005)", body.get("error") == "E3005", f"body={body}")

        # 4e) password 字段的 hmac 用错密码算 -> 被拒
        tok = gw.challenge(OK_USER, "192.168.70.5")
        wrong_hmd5 = make_password_field(tok, "not-my-password")[1]
        text = login_raw(OK_USER, "192.168.70.5", OK_PWD, token=tok, fetch=False,
                         hmd5_override=wrong_hmd5)
        body = jsonp_body(text)
        print(f"  · password hmac 错误: {text!r}")
        rep.check("password hmac 错误被拒 (E3005)", body.get("error") == "E3005", f"body={body}")

        # 4f) chksum 校验通过但 n/type/ac_id 被改 -> E3002
        tok = gw.challenge(OK2_USER, "192.168.70.6")
        pwd_field, hmd5 = make_password_field(tok, OK2_PWD)
        info = make_info_field(OK2_USER, OK2_PWD, "192.168.70.6", tok)
        _, text = gw.portal({
            "callback": "cb", "action": "login", "username": OK2_USER,
            "password": pwd_field, "ac_id": AC_ID, "ip": "192.168.70.6", "info": info,
            "chksum": make_chksum(tok, OK2_USER, hmd5, "192.168.70.6", info),
            "n": "100", "type": TYPE, "os": "Windows 10", "name": "Windows",
            "double_stack": "0",
        })
        body = jsonp_body(text)
        print(f"  · n 被改成 100: {text!r}")
        rep.check("n 不匹配被拒 (E3002)", body.get("error") == "E3002", f"body={body}")

        # 4g) token 重放
        replay = gw.challenge(OK2_USER, "192.168.70.7")
        first = jsonp_body(login_raw(OK2_USER, "192.168.70.7", OK2_PWD, token=replay, fetch=False))
        second_text = login_raw(OK2_USER, "192.168.70.7", OK2_PWD, token=replay, fetch=False)
        second = jsonp_body(second_text)
        print(f"  · token 重放: 第一次={first.get('error')!r} 第二次={second_text!r}")
        rep.check("token 一次性(第一次成功)", first.get("error") == "ok", f"body={first}")
        rep.check("token 重放被拒 (E3002)", second.get("error") == "E3002", f"body={second}")


def scenario_faults(rep: Report):
    section("场景 5: 故障注入 (refuse/timeout/500/garbage/drop-after-n) 必须抛 SrunError")
    for mode in ("refuse", "timeout", "500", "garbage"):
        with ctx_gateway(fixtures={"onlineSessions": []}, fail_mode=mode) as gw:
            client = gw.client(timeout=2)
            t0 = time.time()
            try:
                client.login(OK_USER, OK_PWD, ip=ONLINE_IP)
                rep.check(f"failMode={mode} 抛出 SrunError", False, "居然没抛异常")
            except SrunError as exc:
                elapsed = time.time() - t0
                print(f"  · failMode={mode}: SrunError(kind={exc.kind}) {exc}  ({elapsed:.2f}s)")
                rep.check(f"failMode={mode} 抛出 SrunError", True, f"kind={exc.kind} msg={exc}")
                rep.check(f"failMode={mode} 未挂死 (<20s)", elapsed < 20, f"elapsed={elapsed:.2f}s")
                rep.eq(f"failMode={mode} kind", exc.kind, "parse" if mode == "garbage" else "network")
            except Exception as exc:  # noqa: BLE001
                rep.check(f"failMode={mode} 抛出 SrunError", False,
                          f"抛出了非 SrunError: {type(exc).__name__}: {exc}")

    with ctx_gateway(fixtures={"onlineSessions": []}, fail_mode="refuse") as gw:
        try:
            gw.client(timeout=2).query_status(force=True)
            rep.check("refuse 下 query_status 抛 SrunError", False, "居然没抛异常")
        except SrunError as exc:
            rep.check("refuse 下 query_status 抛 SrunError", True, f"kind={exc.kind} msg={exc}")

    # 运行中切换场景
    with ctx_gateway(fixtures={"onlineSessions": []}) as gw:
        ok1 = gw.client().login(OK_USER, OK_PWD, ip="192.168.66.42").ok
        rep.check("setScenario 前登录成功", ok1)
        rep.eq("setScenario 写入成功", gw.set_scenario({"failMode": "500"}), True)
        try:
            gw.client(timeout=2).login(OK_USER, OK_PWD, ip="192.168.66.43")
            rep.check("运行中切换到 500 后抛出 SrunError", False, "居然没抛异常")
        except SrunError as exc:
            rep.check("运行中切换到 500 后抛出 SrunError", True, f"kind={exc.kind} msg={exc}")

    # drop-after-n: 前 N 次成功, 之后失败
    with ctx_gateway(fixtures={"onlineSessions": []}) as gw:
        gw.set_scenario({"failMode": "drop-after-n", "dropAfterN": 1})
        try:
            gw.client(timeout=2).login(OK_USER, OK_PWD, ip="192.168.66.44")
            rep.check("drop-after-n 之后必须失败", False, "居然没抛异常")
        except SrunError as exc:
            rep.check("drop-after-n 前 1 次成功后失败", True, f"kind={exc.kind} msg={exc}")


def scenario_request_log(rep: Report):
    section("场景 6: 请求日志与参数名核对 (与真实网关前端 portal.js 对齐)")
    with ctx_gateway(fixtures={"onlineSessions": []}) as gw:
        client = gw.client()
        client.login(OK_USER, OK_PWD, ip=ONLINE_IP)
        client.logout(OK_USER)

        reqs = gw.requests()
        print(f"  mock 共记录 {len(reqs)} 个请求:")
        for r in reqs:
            q = r.get("query") or {}
            print(f"    #{r['seq']:<3} {r['method']:<4} {r['path']:<26} 参数: {','.join(sorted(q.keys()))}")

        login_req = next((r for r in reqs if r["path"].endswith("srun_portal")
                          and (r.get("query") or {}).get("action") == "login"), None)
        logout_req = next((r for r in reqs if r["path"].endswith("srun_portal")
                           and (r.get("query") or {}).get("action") == "logout"), None)
        challenge_req = next((r for r in reqs if r["path"].endswith("get_challenge")
                              and (r.get("query") or {}).get("username") == OK_USER), None)
        status_req = next((r for r in reqs if r["path"].endswith("rad_user_info")), None)

        rep.check("收到 get_challenge", challenge_req is not None)
        rep.check("收到 srun_portal?action=login", login_req is not None)
        rep.check("收到 srun_portal?action=logout", logout_req is not None)
        rep.check("收到 rad_user_info", status_req is not None)

        if challenge_req:
            got = set((challenge_req["query"] or {}).keys())
            rep.check("challenge 参数名 ⊇ {callback,username,ip}", CHALLENGE_KEYS <= got,
                      f"got={sorted(got)}")
        if login_req:
            q = login_req["query"]
            got = set(q.keys())
            rep.check("login 参数名 ⊇ portal.js 的集合", PORTAL_LOGIN_KEYS <= got,
                      f"缺少={sorted(PORTAL_LOGIN_KEYS - got)} got={sorted(got)}")
            rep.eq("login.action", q.get("action"), "login")
            rep.eq("login.username", q.get("username"), OK_USER)
            rep.eq("login.ac_id", q.get("ac_id"), AC_ID)
            rep.eq("login.n", q.get("n"), N)
            rep.eq("login.type", q.get("type"), TYPE)
            rep.eq("login.ip", q.get("ip"), ONLINE_IP)
            rep.check("login.password 为花括号包裹的 32 位 hex",
                      len(q.get("password", "")) == 34 and q["password"].startswith("{")
                      and q["password"].endswith("}"), f"password={q.get('password')!r}")
            rep.check("login.info 以 {SRUN3} 前缀开头", str(q.get("info", "")).startswith("{SRUN3}"),
                      f"info[:12]={str(q.get('info'))[:12]!r}")
            rep.eq("login.chksum 为 40 位 sha1 hex", len(q.get("chksum", "")), 40)
        if logout_req:
            got = set((logout_req["query"] or {}).keys())
            rep.check("logout 参数名 ⊇ {action,username,ac_id,ip}", PORTAL_LOGOUT_KEYS <= got,
                      f"got={sorted(got)}")
        if status_req:
            # 参考实现现在优先请求**带 callback 的命名响应**(字段语义无歧义,
            # 见 srun_client.query_status), 所以这里断言: 只带 callback, 不带
            # username/ip —— 真实网关按 TCP 源 IP 识别客户端。
            status_query = status_req["query"] or {}
            rep.check(
                "rad_user_info 只带 callback(优先命名响应)",
                set(status_query.keys()) == {"callback"},
                f"query={status_query}",
            )

        # 真实网关前端 JS 佐证: 参数名/路径/前缀确实来自抓包文件
        try:
            with open(PORTAL_JS, "r", encoding="utf-8", errors="replace") as fh:
                portal_src = fh.read()
        except OSError:
            portal_src = ""
        markers = {
            "get_challenge 路径": "/cgi-bin/get_challenge",
            "srun_portal 路径": "/cgi-bin/srun_portal",
            "rad_user_info 路径": "/cgi-bin/rad_user_info",
            "login action": 'action: "login"',
            "logout action": 'action: "logout"',
            "chksum 参数": "chksum: chksum(chkstr)",
            "info 参数": "info: i,",
            "n 参数": "n: n,",
            "type 参数": "type: type,",
            "double_stack 参数": "double_stack:data.double_stack",
            "SRBX1 info 前缀": '"{SRBX1}" + $.base64.encode(xEncode(json(d), k))',
        }
        missing = [name for name, m in markers.items() if m not in portal_src]
        rep.check("portal.js 中能找到全部参数名/路径佐证", not missing, f"未命中={missing}")


def scenario_alt_flavors(rep: Report):
    section("场景 7: 网关侧流派开关 (passwordAlgo / infoFormat)")
    for algo in ("srun3", "srbx1"):
        for fmt in ("srun3", "srbx1", "none"):
            with ctx_gateway(fixtures={"onlineSessions": []},
                             password_algo=algo, info_format=fmt) as gw:
                try:
                    res = gw.client().login(OK_USER, OK_PWD, ip="192.168.71.1",
                                            password_algo=algo, info_format=fmt)
                    rep.check(f"passwordAlgo={algo} + infoFormat={fmt} 登录成功", res.ok,
                              f"ok={res.ok} code={res.code!r} message={res.message!r}")
                except SrunError as exc:
                    rep.check(f"passwordAlgo={algo} + infoFormat={fmt} 登录成功", False,
                              f"SrunError: {exc}")
    with ctx_gateway(fixtures={"onlineSessions": []}, password_algo="srbx1") as gw:
        res = gw.client().login(OK_USER, OK_PWD, ip="192.168.71.2", password_algo="srun3")
        rep.check("客户端/网关 passwordAlgo 不匹配时被拒", (not res.ok),
                  f"code={res.code!r} message={res.message!r}")


# ------------------------------------------------------------------ main

def main() -> int:
    parser = argparse.ArgumentParser(description="Python 参考实现 <-> mock 网关 集成测试")
    parser.add_argument("--verbose", action="store_true", help="打印 mock 的完整 stdout 日志")
    args = parser.parse_args()

    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

    if not os.path.exists(MOCK_JS):
        print(f"找不到 mock: {MOCK_JS}", file=sys.stderr)
        return 2
    if shutil.which("node") is None:
        print("PATH 中找不到 node", file=sys.stderr)
        return 2

    print("Python 参考实现 <-> mock SRun 网关 集成测试")
    print(f"  mock:   {MOCK_JS}")
    print(f"  node:   {shutil.which('node')}")
    print(f"  python: {sys.version.split()[0]}")
    print(f"  参考实现: {os.path.join(REPO_ROOT, 'hautguard', 'srun_client.py')}")
    print(f"  固定 token: {FIXED_TOKEN}")

    rep = Report()
    started = time.time()
    try:
        scenario_fixture_contract(rep)
        scenario_status(rep)
        scenario_login(rep)
        scenario_logout(rep)
        scenario_tamper(rep)
        scenario_faults(rep)
        scenario_request_log(rep)
        scenario_alt_flavors(rep)
    except Exception:  # noqa: BLE001
        print("\n测试脚本自身异常:", file=sys.stderr)
        traceback.print_exc()
        rep.failed += 1

    elapsed = time.time() - started
    section("汇总")
    print(f"  通过 {rep.passed} / 失败 {rep.failed}   用时 {elapsed:.2f}s")
    if rep.failed:
        print("\n  失败项:")
        for ok, name, detail in rep.rows:
            if not ok:
                print(f"    - {name}  {detail}")
        return 1
    print("  全部通过")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
