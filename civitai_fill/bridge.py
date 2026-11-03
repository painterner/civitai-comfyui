"""Relays the tools that need the open workflow (snapshot, dry run, apply) to a ComfyUI browser tab.

Rules are JS and run in the page (web/worker.js), so an agent's request goes to the tab over ComfyUI's
WebSocket and the tab posts the result back to /civitai-fill/bridge/<id>. The first tab to answer wins.
"""
import asyncio
import uuid


class BridgeError(Exception):
    pass


class Bridge:
    def __init__(self, send, connected):
        self._send, self._connected, self._pending = send, connected, {}

    async def call(self, action, args=None, timeout=60):
        if not self._connected():
            raise BridgeError("没有打开的 ComfyUI 页面：请在浏览器打开 ComfyUI（规则在页面里运行）")
        request_id = uuid.uuid4().hex
        future = asyncio.get_running_loop().create_future()
        self._pending[request_id] = future
        try:
            await self._send("civitai-fill.request", {"id": request_id, "action": action, "args": args or {}})
            result = await asyncio.wait_for(future, timeout)
        except asyncio.TimeoutError:
            raise BridgeError(f"ComfyUI 页面 {timeout} 秒内没有响应：请确认页面已加载 Civitai 填充插件") from None
        finally:
            self._pending.pop(request_id, None)
        if result.get("error"):
            raise BridgeError(result["error"])
        return result.get("result")

    def resolve(self, request_id, body):
        future = self._pending.get(request_id)
        if not future or future.done():
            return False
        future.set_result(body if isinstance(body, dict) else {"error": "页面返回的结果格式无效"})
        return True
