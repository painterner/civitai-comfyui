"""Settings and rule files under ComfyUI's user directory (user/<user>/civitai-fill/).

Secrets (MaiHub token, model API key) are write-only: they are never returned to the browser or to MCP.
Built-in rules ship in the package's rules/ folder and are read-only.
"""
import json
import os
import re
import time
from pathlib import Path

PACKAGE_RULES = Path(__file__).resolve().parent.parent / "rules"
RULE_ID = re.compile(r"[a-z0-9][a-z0-9-]{0,63}")
DEFAULTS = {"maihub_url": "https://maihub.painterner.me", "maihub_token": "", "llm_base_url": "", "llm_api_key": "", "llm_model": ""}
SECRETS = {"maihub_token", "llm_api_key"}


def rule_header(source):
    header = {}
    for line in source.splitlines():
        text = line.strip()
        if not text:
            continue
        if not text.startswith("//"):
            break
        match = re.match(r"^//\s*@(name|description)\s+(.+)$", text)
        if match:
            header[match.group(1)] = match.group(2).strip()
    return header


def rule_problems(source):
    """The same checks as web/facade.js ruleSourceProblems: one self-contained module."""
    if not isinstance(source, str) or not source.strip():
        return ["规则为空"]
    problems = []
    if len(source) > 200_000:
        problems.append("规则超过 200 KB")
    if re.search(r"^\s*import[\s{*]", source, re.M) or re.search(r"\bimport\s*\(", source):
        problems.append("规则不能 import 其他模块")
    if not rule_header(source).get("name"):
        problems.append("缺少 // @name 头注释")
    if not re.search(r"export\s+default\s", source):
        problems.append("缺少 export default function apply(report, wf, h)")
    return problems


class Store:
    def __init__(self, root):
        self.root = Path(root)
        self.rules = self.root / "rules"

    # Settings
    def _settings_path(self):
        return self.root / "settings.json"

    def settings(self):
        try:
            saved = json.loads(self._settings_path().read_text())
        except (OSError, ValueError):
            saved = {}
        return {**DEFAULTS, **{k: v for k, v in saved.items() if k in DEFAULTS and isinstance(v, str)}}

    def public_settings(self):
        values = self.settings()
        return {**{k: v for k, v in values.items() if k not in SECRETS}, **{f"{k}_set": bool(values[k]) for k in SECRETS}}

    def update_settings(self, changes):
        if not isinstance(changes, dict) or any(k not in DEFAULTS or not isinstance(v, str) or len(v) > 4096 for k, v in changes.items()):
            raise ValueError("设置只接受 " + ", ".join(DEFAULTS) + "（字符串）")
        for key in ("maihub_url", "llm_base_url"):
            if changes.get(key) and not re.match(r"^https?://[^\s/]+", changes[key]):
                raise ValueError(f"{key} 需要 http(s) 地址")
        values = {**self.settings(), **{k: v.strip().rstrip("/") if k.endswith("_url") else v.strip() for k, v in changes.items()}}
        self.root.mkdir(parents=True, exist_ok=True)
        path = self._settings_path()
        temporary = path.with_suffix(".tmp")
        temporary.write_text(json.dumps(values, ensure_ascii=False, indent=2))
        os.chmod(temporary, 0o600)
        temporary.replace(path)
        return self.public_settings()

    # Rules
    def _entry(self, path, builtin):
        source = path.read_text()
        header = rule_header(source)
        return {"id": path.stem, "name": header.get("name", path.stem), "description": header.get("description", ""),
                "builtin": builtin, "updatedAt": int(path.stat().st_mtime * 1000)}

    def list_rules(self):
        entries = [self._entry(p, True) for p in sorted(PACKAGE_RULES.glob("*.js"))]
        if self.rules.is_dir():
            entries += [self._entry(p, False) for p in sorted(self.rules.glob("*.js")) if RULE_ID.fullmatch(p.stem)]
        return entries

    def _path(self, rule_id):
        if not isinstance(rule_id, str) or not RULE_ID.fullmatch(rule_id):
            raise ValueError("规则 ID 只能用小写字母、数字和 -（最多 64 个字符）")
        builtin = PACKAGE_RULES / f"{rule_id}.js"
        return (builtin, True) if builtin.is_file() else (self.rules / f"{rule_id}.js", False)

    def get_rule(self, rule_id):
        path, builtin = self._path(rule_id)
        if not path.is_file():
            raise KeyError(f"没有规则 {rule_id}")
        return {**self._entry(path, builtin), "source": path.read_text()}

    def save_rule(self, rule_id, source):
        path, builtin = self._path(rule_id)
        if builtin:
            raise ValueError(f"内置规则 {rule_id} 不能覆盖，请换一个 ID")
        problems = rule_problems(source)
        if problems:
            raise ValueError("；".join(problems))
        self.rules.mkdir(parents=True, exist_ok=True)
        path.write_text(source)
        return self._entry(path, False)

    def delete_rule(self, rule_id):
        path, builtin = self._path(rule_id)
        if builtin:
            raise ValueError("内置规则不能删除")
        if not path.is_file():
            raise KeyError(f"没有规则 {rule_id}")
        path.unlink()
        return {"id": rule_id, "deleted": True, "at": int(time.time() * 1000)}
