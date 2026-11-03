"""Backend without ComfyUI: settings and rules, MCP, the browser bridge, and the MaiHub / model clients
against local fake servers (random ports)."""
import asyncio
import json
import os
import stat
import sys
import tempfile
from pathlib import Path

from aiohttp import web

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from civitai_fill import ai, maihub, mcp  # noqa: E402
from civitai_fill.bridge import Bridge, BridgeError  # noqa: E402
from civitai_fill.store import Store, rule_problems  # noqa: E402

RULE = "// @name 测试规则\n// @description 只设种子\nexport default function apply(report, wf, h) { wf.one('KSampler')?.set('seed', h.params().seed); }\n"


def raises(fn, fragment):
    try:
        fn()
    except (ValueError, KeyError) as error:
        assert fragment in str(error), str(error)
        return
    raise AssertionError("accepted: " + fragment)


async def serve(handlers):
    app = web.Application()
    for method, path, handler in handlers:
        app.router.add_route(method, path, handler)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    port = site._server.sockets[0].getsockname()[1]
    return runner, f"http://127.0.0.1:{port}"


def test_store():
    with tempfile.TemporaryDirectory() as directory:
        store = Store(directory)
        assert store.public_settings()["maihub_url"] == "https://maihub.painterner.me" and store.public_settings()["maihub_token_set"] is False
        public = store.update_settings({"maihub_token": "mh_secret", "llm_base_url": "https://llm.example/v1/", "llm_model": "m"})
        assert "maihub_token" not in public and public["maihub_token_set"] and public["llm_base_url"] == "https://llm.example/v1"
        assert "mh_secret" not in json.dumps(store.public_settings()) and store.settings()["maihub_token"] == "mh_secret"
        assert stat.S_IMODE(os.stat(Path(directory, "settings.json")).st_mode) == 0o600, "secrets are private to the user"
        raises(lambda: store.update_settings({"other": "x"}), "设置只接受")
        raises(lambda: store.update_settings({"maihub_url": "ftp://x"}), "http(s)")
        # Rules: the built-in one is listed and read-only; saved ones round-trip.
        assert [r["id"] for r in store.list_rules() if r["builtin"]] == ["generic"]
        assert store.get_rule("generic")["name"] == "通用文生图 / 图生图"
        raises(lambda: store.save_rule("generic", RULE), "内置规则")
        saved = store.save_rule("my-rule", RULE)
        assert saved == {**saved, "id": "my-rule", "name": "测试规则", "description": "只设种子", "builtin": False}
        assert store.get_rule("my-rule")["source"] == RULE
        raises(lambda: store.save_rule("Bad ID", RULE), "规则 ID")
        raises(lambda: store.save_rule("x", "export default 1"), "@name")
        store.delete_rule("my-rule")
        raises(lambda: store.get_rule("my-rule"), "没有规则")
        assert rule_problems("// @name a\nimport x from 'y'\nexport default function(){}") == ["规则不能 import 其他模块"]


async def test_mcp():
    calls = []

    async def inspect(args):
        calls.append(args)
        return {"imageId": "1"}

    async def broken(_args):
        raise BridgeError("没有打开的 ComfyUI 页面")
    tools = {"civitai_inspect": inspect, "civitai_workflow_snapshot": broken}
    init = await mcp.handle({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-03-26"}}, tools)
    assert init["result"]["protocolVersion"] == "2025-03-26" and init["result"]["capabilities"]["tools"]
    assert await mcp.handle({"jsonrpc": "2.0", "method": "notifications/initialized"}, tools) is None
    listed = await mcp.handle({"jsonrpc": "2.0", "id": 2, "method": "tools/list"}, tools)
    assert [t["name"] for t in listed["result"]["tools"]] == ["civitai_inspect", "civitai_rule_spec", "civitai_workflow_snapshot", "civitai_list_rules",
                                                              "civitai_get_rule", "civitai_dry_run_rule", "civitai_save_rule", "civitai_apply_rule"]
    called = await mcp.handle({"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "civitai_inspect", "arguments": {"url": "u"}}}, tools)
    assert json.loads(called["result"]["content"][0]["text"]) == {"imageId": "1"} and calls == [{"url": "u"}]
    failed = await mcp.handle({"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "civitai_workflow_snapshot"}}, tools)
    assert failed["result"]["isError"] and "ComfyUI" in failed["result"]["content"][0]["text"]
    assert (await mcp.handle({"jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": {"name": "nope"}}, tools))["error"]["code"] == -32602
    assert (await mcp.handle({"jsonrpc": "2.0", "id": 6, "method": "nope"}, tools))["error"]["code"] == -32601


async def test_bridge():
    sent = []
    bridge = Bridge(send=None, connected=lambda: False)
    try:
        await bridge.call("snapshot")
        raise AssertionError("no tab")
    except BridgeError as error:
        assert "ComfyUI" in str(error)

    async def send(event, data):
        sent.append((event, data))
        asyncio.get_running_loop().call_soon(bridge.resolve, data["id"], {"result": {"nodes": []}})
    bridge = Bridge(send=send, connected=lambda: True)
    assert await bridge.call("snapshot") == {"nodes": []} and sent[0][0] == "civitai-fill.request" and sent[0][1]["action"] == "snapshot"
    assert bridge.resolve("unknown", {}) is False

    async def silent(event, data):
        pass
    try:
        await Bridge(send=silent, connected=lambda: True).call("snapshot", timeout=0.1)
        raise AssertionError("timeout")
    except BridgeError as error:
        assert "没有响应" in str(error)


async def test_maihub_and_ai():
    seen = {}

    async def infer(request):
        seen["auth"], seen["body"] = request.headers.get("Authorization"), await request.json()
        if seen["body"]["input"]["url"].endswith("/404"):
            return web.json_response({"error": "Civitai 接口未返回这张图片"}, status=404)
        return web.json_response({"status": "succeeded", "output": json.dumps({"schemaVersion": 1, "imageId": "9"})})

    async def asset(request):
        return web.Response(body=b"\x89PNG", content_type="image/png")

    async def chat(request):
        body = await request.json()
        seen["chat"] = body
        if request.headers.get("Authorization") != "Bearer sk-test":
            return web.json_response({"error": {"message": "bad key"}}, status=401)
        return web.json_response({"choices": [{"message": {"content": "这是规则：\n```js\n" + RULE + "```\n已按 KSampler 填种子。"}}]})
    runner, base = await serve([("POST", "/api/infer", infer), ("GET", "/api/assets/{id}", asset), ("POST", "/v1/chat/completions", chat)])
    try:
        settings = {"maihub_url": base, "maihub_token": "mh_t"}
        assert await maihub.inspect(settings, "https://civitai.com/images/9") == {"schemaVersion": 1, "imageId": "9"}
        assert seen["auth"] == "Bearer mh_t" and seen["body"] == {"model": "civitai-inspect", "providerId": "maihub", "input": {"url": "https://civitai.com/images/9"}}
        for url, fragment, status in [("https://civitai.com/images/404", "未返回", 404), ("https://example.com/x", "Civitai 作品地址", 400)]:
            try:
                await maihub.inspect(settings, url)
                raise AssertionError(url)
            except maihub.MaiHubError as error:
                assert fragment in str(error) and error.status == status
        try:
            await maihub.inspect({"maihub_url": base, "maihub_token": ""}, "https://civitai.com/images/9")
            raise AssertionError("token required")
        except maihub.MaiHubError as error:
            assert "API Token" in str(error)
        data, extension = await maihub.asset(settings, "maihub-asset:11111111-1111-4111-8111-111111111111")
        assert (data, extension) == (b"\x89PNG", "png")
        # AI: the spec and the built-in rule are in the prompt; the reply's code block comes back.
        llm = {"llm_base_url": base + "/v1", "llm_model": "m", "llm_api_key": "sk-test"}
        result = await ai.generate(llm, workflow={"nodes": []}, report={"generation": {}}, instruction="只设种子")
        assert result["source"] == RULE and "KSampler" in result["explanation"]
        system = seen["chat"]["messages"][0]["content"]
        assert "映射规则规范" in system and "通用文生图" in system and seen["chat"]["model"] == "m"
        assert json.loads(seen["chat"]["messages"][1]["content"])["instruction"] == "只设种子"
        fixed = await ai.generate(llm, workflow={}, report={}, previous=RULE, problems=["KSampler（3）没有控件 sead"])
        request = json.loads(seen["chat"]["messages"][1]["content"])
        assert fixed["source"] == RULE and request["previous_rule"] == RULE and request["problems"] == ["KSampler（3）没有控件 sead"]
        try:
            await ai.generate({**llm, "llm_api_key": "wrong"}, workflow={}, report={})
            raise AssertionError("bad key")
        except ai.AIError as error:
            assert "401" in str(error) and "bad key" in str(error) and error.status == 401
        try:
            await ai.generate({"llm_base_url": "", "llm_model": ""}, workflow={}, report={})
            raise AssertionError("not configured")
        except ai.AIError as error:
            assert error.status == 400
        assert ai.extract_source("export default function apply(){}") == "export default function apply(){}\n"
    finally:
        await runner.cleanup()


async def main():
    test_store()
    await test_mcp()
    await test_bridge()
    await test_maihub_and_ai()
    print("PASS backend: settings and rules, MCP, bridge, MaiHub and model clients")


asyncio.run(main())
