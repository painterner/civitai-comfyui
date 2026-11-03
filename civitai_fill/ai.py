"""「AI 生成规则」: asks the configured OpenAI-compatible model for a mapping rule (docs/RULES.md).

The panel sends a compact snapshot of the current workflow and the parse report; the reply's code is
returned for a dry run and review before anything is saved. Validation problems can be sent back for a fix.
"""
import json
import re
from pathlib import Path

import aiohttp

ROOT = Path(__file__).resolve().parent.parent
SYSTEM = """你为 ComfyUI 插件「Civitai 填充」编写映射规则：一个 JS 模块，把 Civitai 作品的解析结果（report）写进给定的工作流。
严格遵守下面的规则规范，只使用规范里的 wf / h 接口；控件名、节点类型和连线以用户给出的工作流快照为准，不要猜。
优先通过连线定位节点（如 h.positive(sampler)），让规则能复用于同类工作流。只设置 report 里有的参数。
回复只包含一个 ```js 代码块，内容是完整的规则模块（含 // @name 和 // @description 头注释），代码块外可以有一两句说明。"""


class AIError(Exception):
    def __init__(self, message, status=502):
        super().__init__(message)
        self.status = status


def extract_source(text):
    blocks = re.findall(r"```(?:js|javascript|mjs)?\s*\n(.*?)```", text or "", re.S)
    source = max(blocks, key=len) if blocks else (text if "export default" in (text or "") else "")
    if not source.strip():
        raise AIError("模型没有返回规则代码")
    return source.strip() + "\n"


def prompt_messages(workflow, report, instruction="", previous="", problems=()):
    spec = (ROOT / "docs" / "RULES.md").read_text()
    example = (ROOT / "rules" / "generic.js").read_text()
    system = f"{SYSTEM}\n\n# 规则规范\n\n{spec}\n\n# 内置示例规则（rules/generic.js）\n\n```js\n{example}```"
    request = {"instruction": instruction or "为这个工作流写一条规则，把 report 的参数填进去。", "workflow": workflow, "report": report}
    if previous:
        request["previous_rule"] = previous
        request["problems"] = list(problems)
        request["instruction"] += "\n上一版规则试运行有这些问题，请修正后给出完整规则。"
    return [{"role": "system", "content": system}, {"role": "user", "content": json.dumps(request, ensure_ascii=False)}]


async def generate(settings, *, workflow, report, instruction="", previous="", problems=(), session=None):
    if not settings.get("llm_base_url") or not settings.get("llm_model"):
        raise AIError("请先在设置里填写模型服务地址（OpenAI 兼容）和模型名", 400)
    headers = {"Authorization": "Bearer " + settings["llm_api_key"]} if settings.get("llm_api_key") else {}
    owned = session is None
    session = session or aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=240))
    try:
        async with session.post(settings["llm_base_url"] + "/chat/completions", headers=headers, json={
                "model": settings["llm_model"], "temperature": 0.2,
                "messages": prompt_messages(workflow, report, instruction, previous, problems)}) as response:
            body = await response.json(content_type=None)
            if response.status != 200:
                message = ((body or {}).get("error") or {}).get("message") if isinstance((body or {}).get("error"), dict) else (body or {}).get("error")
                raise AIError(f"模型服务返回 HTTP {response.status}：{message or ''}".rstrip("："), response.status if response.status < 500 else 502)
            text = body["choices"][0]["message"]["content"]
    except aiohttp.ClientError as error:
        raise AIError(f"无法连接模型服务：{error}") from None
    except (KeyError, IndexError, TypeError):
        raise AIError("模型服务返回格式不是 Chat Completions") from None
    finally:
        if owned:
            await session.close()
    source = extract_source(text)
    explanation = re.sub(r"```.*?```", "", text, flags=re.S).strip()
    return {"source": source, "explanation": explanation[:2000]}
