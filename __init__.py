"""Civitai 填充 (civitai-comfyui): fills the current ComfyUI workflow from a Civitai image page.

Parsing goes through MaiHub's Civitai 资源解析 API; JS mapping rules (docs/RULES.md) run in the browser.
Rules come with the plugin, from the panel's 「AI 生成规则」, or from agents over HTTP / MCP (/civitai-fill/mcp).
"""
from .civitai_fill import routes  # noqa: F401  registers the HTTP API and the MCP endpoint

WEB_DIRECTORY = "./web"
NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}
__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
