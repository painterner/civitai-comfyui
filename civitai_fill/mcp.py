"""MCP (Streamable HTTP, JSON responses) at POST /civitai-fill/mcp: the same tools as the HTTP API.

Add it to an MCP client as a streamable-HTTP server, e.g. `claude mcp add --transport http civitai-fill
http://127.0.0.1:8188/civitai-fill/mcp`. Tools that touch the workflow need an open ComfyUI tab.
"""
import json

PROTOCOL_VERSIONS = ("2025-06-18", "2025-03-26", "2024-11-05")
SERVER_INFO = {"name": "civitai-comfyui", "title": "Civitai 填充", "version": "1.0.0"}
INSTRUCTIONS = ("Civitai 填充：用 Civitai 作品参数填充当前 ComfyUI 工作流。写规则前先读 get_rule_spec 和 get_current_workflow，"
                "用 dry_run_rule 试运行到没有提醒再 save_rule；apply_rule 会修改用户打开的工作流（可撤销）。")
_url = {"type": "string", "description": "Civitai 作品地址，如 https://civitai.com/images/123"}
_rule = {"source": {"type": "string", "description": "完整的规则 JS 源码"}, "id": {"type": "string", "description": "已保存的规则 ID"},
         "url": _url, "report": {"type": "object", "description": "civitai_inspect 的结果（与 url 二选一）"}}
TOOLS = [
    {"name": "civitai_inspect", "description": "解析 Civitai 作品（经 MaiHub）：checkpoint、LoRA、生成参数、作品图片",
     "inputSchema": {"type": "object", "properties": {"url": _url}, "required": ["url"]}},
    {"name": "get_rule_spec", "description": "映射规则规范（规则格式、report 字段、wf / h 接口）和内置示例规则",
     "inputSchema": {"type": "object", "properties": {}}},
    {"name": "get_current_workflow", "description": "用户 ComfyUI 页面当前工作流的快照：节点、控件、连线、本机模型列表",
     "inputSchema": {"type": "object", "properties": {}}},
    {"name": "list_rules", "description": "已有规则（内置和已保存）", "inputSchema": {"type": "object", "properties": {}}},
    {"name": "get_rule", "description": "读取一条规则的源码", "inputSchema": {"type": "object", "properties": {"id": {"type": "string"}}, "required": ["id"]}},
    {"name": "dry_run_rule", "description": "在当前工作流上试运行规则，返回修改预览、提醒和缺少的模型，不改动工作流",
     "inputSchema": {"type": "object", "properties": _rule}},
    {"name": "save_rule", "description": "保存规则（ID 只能用小写字母、数字和 -）",
     "inputSchema": {"type": "object", "properties": {"id": {"type": "string"}, "source": {"type": "string"}}, "required": ["id", "source"]}},
    {"name": "apply_rule", "description": "把规则应用到用户当前的工作流（一次可撤销的修改）", "inputSchema": {"type": "object", "properties": _rule}},
]


def _ok(message_id, result):
    return {"jsonrpc": "2.0", "id": message_id, "result": result}


def _error(message_id, code, message):
    return {"jsonrpc": "2.0", "id": message_id, "error": {"code": code, "message": message}}


async def handle(message, tools):
    """One JSON-RPC message -> a response, or None for a notification."""
    if not isinstance(message, dict) or message.get("jsonrpc") != "2.0" or not isinstance(message.get("method"), str):
        return _error(message.get("id") if isinstance(message, dict) else None, -32600, "Invalid Request")
    method, message_id = message["method"], message.get("id")
    if "id" not in message:
        return None
    params = message.get("params") or {}
    if method == "initialize":
        wanted = params.get("protocolVersion")
        return _ok(message_id, {"protocolVersion": wanted if wanted in PROTOCOL_VERSIONS else PROTOCOL_VERSIONS[0],
                                "capabilities": {"tools": {"listChanged": False}}, "serverInfo": SERVER_INFO, "instructions": INSTRUCTIONS})
    if method == "ping":
        return _ok(message_id, {})
    if method == "tools/list":
        return _ok(message_id, {"tools": TOOLS})
    if method == "tools/call":
        name = params.get("name")
        if name not in tools:
            return _error(message_id, -32602, f"Unknown tool: {name}")
        try:
            result = await tools[name](params.get("arguments") or {})
        except Exception as error:  # tool failures are results the model can read and act on
            return _ok(message_id, {"content": [{"type": "text", "text": str(error) or error.__class__.__name__}], "isError": True})
        text = result if isinstance(result, str) else json.dumps(result, ensure_ascii=False, indent=1)
        return _ok(message_id, {"content": [{"type": "text", "text": text}]})
    return _error(message_id, -32601, f"Method not found: {method}")
