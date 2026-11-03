"""HTTP API under /civitai-fill/ on ComfyUI's server, and the MCP endpoint; both use the same tools.

  GET/PUT  /civitai-fill/settings          MaiHub address + token, model service (secrets write-only)
  POST     /civitai-fill/inspect           {url} -> report (MaiHub Civitai 资源解析)
  POST     /civitai-fill/input-image       {reference} -> {name}: a work image saved into ComfyUI's input folder
  GET      /civitai-fill/rules[/{id}]      rule list / one rule;  PUT {source} saves, DELETE removes
  GET      /civitai-fill/spec              docs/RULES.md
  POST     /civitai-fill/ai/generate       {workflow, report, instruction?, previous?, problems?} -> {source, explanation}
  POST     /civitai-fill/workflow | dry-run | apply   the open tab's workflow; {source|id, url|report}
  POST     /civitai-fill/mcp               MCP (Streamable HTTP)
"""
from pathlib import Path

import folder_paths
from aiohttp import web
from server import PromptServer

from . import ai, maihub, mcp
from .bridge import Bridge, BridgeError
from .store import Store

ROOT = Path(__file__).resolve().parent.parent
server = PromptServer.instance
store = Store(Path(folder_paths.get_user_directory()) / "default" / "civitai-fill")
bridge = Bridge(send=lambda event, data: server.send(event, data), connected=lambda: bool(server.sockets))
routes = server.routes


def _status(error):
    if isinstance(error, (maihub.MaiHubError, ai.AIError)):
        return error.status
    if isinstance(error, BridgeError):
        return 409
    if isinstance(error, KeyError):
        return 404
    return 400 if isinstance(error, ValueError) else 500


def _message(error):
    return error.args[0] if isinstance(error, KeyError) and error.args else str(error)


async def _body(request):
    try:
        data = await request.json()
    except ValueError:
        raise ValueError("请求需要 JSON 对象") from None
    if not isinstance(data, dict):
        raise ValueError("请求需要 JSON 对象")
    return data


def endpoint(handler):
    async def wrapped(request):
        try:
            result = await handler(request)
            return result if isinstance(result, web.StreamResponse) else web.json_response(result)
        except Exception as error:
            return web.json_response({"error": _message(error)}, status=_status(error))
    return wrapped


# Tools shared by the HTTP API, MCP and the panel.
async def _rule_and_report(args):
    source = args.get("source") or (store.get_rule(args["id"])["source"] if args.get("id") else None)
    if not source:
        raise ValueError("需要 source（规则源码）或 id（已保存的规则）")
    report = args.get("report") or (await maihub.inspect(store.settings(), args["url"]) if args.get("url") else None)
    if not isinstance(report, dict):
        raise ValueError("需要 url（Civitai 作品地址）或 report（解析结果）")
    return source, report


async def tool_spec(_args):
    return (ROOT / "docs" / "RULES.md").read_text() + "\n\n# 内置示例规则（rules/generic.js）\n\n```js\n" + (ROOT / "rules" / "generic.js").read_text() + "```\n"


async def tool_dry_run(args):
    source, report = await _rule_and_report(args)
    return await bridge.call("dry_run", {"source": source, "report": report})


async def tool_apply(args):
    source, report = await _rule_and_report(args)
    return await bridge.call("apply", {"source": source, "report": report}, timeout=120)


TOOLS = {
    "civitai_inspect": lambda args: maihub.inspect(store.settings(), args.get("url")),
    "civitai_rule_spec": tool_spec,
    "civitai_workflow_snapshot": lambda _args: bridge.call("snapshot"),
    "civitai_list_rules": lambda _args: _async(store.list_rules()),
    "civitai_get_rule": lambda args: _async(store.get_rule(args.get("id"))),
    "civitai_dry_run_rule": tool_dry_run,
    "civitai_save_rule": lambda args: _async(store.save_rule(args.get("id"), args.get("source"))),
    "civitai_apply_rule": tool_apply,
}


async def _async(value):
    return value


@routes.get("/civitai-fill/settings")
@endpoint
async def get_settings(_request):
    return store.public_settings()


@routes.put("/civitai-fill/settings")
@endpoint
async def put_settings(request):
    return store.update_settings(await _body(request))


@routes.post("/civitai-fill/inspect")
@endpoint
async def inspect(request):
    return await maihub.inspect(store.settings(), (await _body(request)).get("url"))


@routes.post("/civitai-fill/input-image")
@endpoint
async def input_image(request):
    reference = (await _body(request)).get("reference")
    data, extension = await maihub.asset(store.settings(), reference)
    folder = Path(folder_paths.get_input_directory()) / "civitai"
    folder.mkdir(parents=True, exist_ok=True)
    name = f"{maihub.ASSET.fullmatch(reference).group(1)}.{extension}"
    (folder / name).write_bytes(data)
    return {"name": f"civitai/{name}"}


@routes.get("/civitai-fill/rules")
@endpoint
async def list_rules(_request):
    return store.list_rules()


@routes.get("/civitai-fill/rules/{rule_id}")
@endpoint
async def get_rule(request):
    return store.get_rule(request.match_info["rule_id"])


@routes.put("/civitai-fill/rules/{rule_id}")
@endpoint
async def save_rule(request):
    return store.save_rule(request.match_info["rule_id"], (await _body(request)).get("source"))


@routes.delete("/civitai-fill/rules/{rule_id}")
@endpoint
async def delete_rule(request):
    return store.delete_rule(request.match_info["rule_id"])


@routes.get("/civitai-fill/spec")
async def spec(_request):
    return web.Response(text=await tool_spec({}), content_type="text/markdown", charset="utf-8")


@routes.post("/civitai-fill/ai/generate")
@endpoint
async def generate(request):
    data = await _body(request)
    return await ai.generate(store.settings(), workflow=data.get("workflow"), report=data.get("report"),
                             instruction=data.get("instruction") or "", previous=data.get("previous") or "", problems=data.get("problems") or [])


@routes.post("/civitai-fill/bridge/{request_id}")
@endpoint
async def bridge_result(request):
    return {"accepted": bridge.resolve(request.match_info["request_id"], await _body(request))}


@routes.post("/civitai-fill/workflow")
@endpoint
async def workflow(_request):
    return await bridge.call("snapshot")


@routes.post("/civitai-fill/dry-run")
@endpoint
async def dry_run(request):
    return await tool_dry_run(await _body(request))


@routes.post("/civitai-fill/apply")
@endpoint
async def apply(request):
    return await tool_apply(await _body(request))


@routes.post("/civitai-fill/mcp")
async def mcp_endpoint(request):
    try:
        payload = await request.json()
    except ValueError:
        return web.json_response({"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "Parse error"}}, status=400)
    if isinstance(payload, list):
        responses = [r for r in [await mcp.handle(m, TOOLS) for m in payload] if r is not None]
        return web.json_response(responses) if responses else web.Response(status=202)
    response = await mcp.handle(payload, TOOLS)
    return web.json_response(response) if response is not None else web.Response(status=202)


@routes.get("/civitai-fill/mcp")
async def mcp_stream(_request):
    # No server-initiated messages: the GET stream of Streamable HTTP is not offered.
    return web.Response(status=405, headers={"Allow": "POST"})


print(f"[civitai-fill] rules in {store.rules}; MCP at /civitai-fill/mcp")
