# Civitai 填充（civitai-comfyui）

ComfyUI 插件：输入 Civitai 作品地址，经 MaiHub「Civitai 资源解析」取得 checkpoint、LoRA、生成参数和作品图片，
再按**映射规则**把它们填进当前工作流。规则是 JS 模块（[规则规范](docs/RULES.md)），不同工作流用不同规则；
规则可以手写，也可以在面板里用「AI 生成规则」生成，或由 Claude Code、Cursor 等通过 HTTP API / MCP 编写。

## 安装

```bash
ln -s /home/ka/all/ai-lib/comfyui/civitai-comfyui /path/to/ComfyUI/custom_nodes/civitai-comfyui
# 重启 ComfyUI。插件只依赖 ComfyUI 自带的 aiohttp，不需要额外安装。
```

左侧栏出现「Civitai 填充」。第一次打开会展开「设置」：

| 设置 | 用途 |
|---|---|
| MaiHub 地址 / API Token | 调用 Civitai 资源解析、下载作品图片。Token 在 MaiHub 网页的「API Token」页创建 |
| 模型服务地址 / API Key / 模型名 | 「AI 生成规则」使用的 OpenAI 兼容服务（Chat Completions），如 `https://api.openai.com/v1` |

设置保存在 `ComfyUI/user/default/civitai-fill/settings.json`（权限 600）；Token 和 API Key 只写不读，不会返回给页面或 MCP。

## 使用

1. 粘贴作品地址（`https://civitai.com/images/…` 或 civitai.red），点「解析」。
2. 规则下拉框按与当前工作流的匹配度排序，默认选最合适的（工作流上次用过的规则优先）。内置「通用文生图 / 图生图」
   覆盖 KSampler 和 SamplerCustomAdvanced 两类工作流：提示词、种子、步数、CFG、采样器、尺寸、checkpoint / UNET、
   VAE、文本编码器、LoRA 链（复用已有 LoRA 节点，不够就新增并接好线）、LoadImage 的输入图片；两个采样器时第二个用第二阶段参数。
3. 「预览」列出每个控件的旧值 → 新值、新增节点和连线、本机缺少的模型（附 Civitai 链接）和提醒；不改动工作流。
4. 「应用到当前工作流」一次写入，可 Ctrl+Z 撤销。作品图片会下载到 ComfyUI 的 `input/civitai/`。

本机模型按 Civitai 版本 ID（文件名含版本号，如 MaiHub 下载的 `maihub/xxx_128713.safetensors`）或名称匹配；
找不到的不替换，只列在「缺少的模型」里。

## 规则

规则是一个 JS 模块：`// @name` 头注释、可选的 `match(wf, report)`（0~1 匹配度）和默认导出的
`apply(report, wf, h)`。规则通过 `wf`（找节点、读写控件、加节点、连线）和 `h`（阶段参数、模型匹配、LoRA 链、
作品图片…）描述修改，在 Web Worker 中运行，返回的修改先预览再应用。完整接口见 [docs/RULES.md](docs/RULES.md)，
示例见 [rules/generic.js](rules/generic.js)。

- 面板「规则代码」：载入规则改写、试运行、应用、按 ID 保存或删除。内置规则只读，另存为新 ID 即可修改。
- 保存的规则在 `ComfyUI/user/default/civitai-fill/rules/<id>.js`。
- 规则是代码：只运行信任的规则。规则不能 import，运行时去掉了网络 API，超时 5 秒。

### AI 生成规则

在面板「AI 生成规则」里点生成（可写补充要求，如「第二个 KSampler 是高清修复」）。插件把规则规范、示例规则、
当前工作流快照和解析结果发给配置的模型，拿回规则后**自动试运行**：如果有「控件不存在」「下拉框没有该值」等问题，
点「让 AI 修正」把问题发回去重写。确认预览和代码后填 ID 保存。

## 给 AI / 程序调用

ComfyUI 运行时，插件在同一端口提供 HTTP API 和 MCP。需要读取或修改工作流的调用，会转给打开着 ComfyUI 的浏览器页面执行，
所以要先在浏览器打开 ComfyUI。

### MCP

```bash
claude mcp add --transport http civitai-fill http://127.0.0.1:8188/civitai-fill/mcp
```

| 工具 | 说明 |
|---|---|
| `civitai_inspect(url)` | 解析作品 |
| `get_rule_spec()` | 规则规范和示例规则 |
| `get_current_workflow()` | 当前工作流快照：节点、控件、连线、本机模型 |
| `list_rules()` / `get_rule(id)` | 已有规则 |
| `dry_run_rule(source\|id, url\|report)` | 试运行：修改预览、提醒、缺少的模型，不改动工作流 |
| `save_rule(id, source)` | 保存规则 |
| `apply_rule(source\|id, url\|report)` | 应用到当前工作流（可撤销） |

Claude Code 等可以配合 [skills/civitai-comfyui-rules/SKILL.md](skills/civitai-comfyui-rules/SKILL.md) 使用。

### HTTP API

```bash
B=http://127.0.0.1:8188/civitai-fill
curl -X POST $B/inspect -d '{"url":"https://civitai.com/images/123456"}'
curl -X POST $B/workflow                                   # 当前工作流快照
curl -X POST $B/dry-run -d '{"id":"generic","url":"https://civitai.com/images/123456"}'
curl -X PUT  $B/rules/my-flux -d @rule.json                # {"source": "// @name …"}
curl -X POST $B/apply   -d '{"id":"my-flux","url":"https://civitai.com/images/123456"}'
curl $B/spec                                               # 规则规范（Markdown）
```

其余：`GET/PUT /settings`、`GET /rules`、`GET/DELETE /rules/{id}`、`POST /ai/generate`、`POST /input-image`。

## 开发与测试

```bash
PYTHON=/path/to/comfyui/python npm test     # 规则运行时、内置规则、后端（设置、规则、MCP、桥接、MaiHub 与模型客户端）
# 真实 ComfyUI + 专用测试浏览器：解析 → 预览 → 应用 → 撤销、MCP、AI 生成与修正、作品图片
node tests/browser-check.mjs --cdp /path/to/browser-automate/scripts/cdp.mjs --comfy http://127.0.0.1:8188 --ai
```

`browser-check` 会改动并撤销打开的工作流，期望设置指向一个返回「默认文生图」适配解析结果的 MaiHub（测试时可用假服务）。

## 与 ComfyUI-Copilot

上游 ComfyUI-Copilot 的 MCP 服务器写死在代码里，不能直接加载本插件的工具。插件自带「AI 生成规则」，
不依赖 Copilot；要让 Copilot 侧栏也能读写规则，可以在自己维护的 Copilot 适配（如 comfy-separate 的 Copilot 服务）里
接入本插件的 MCP 地址。
