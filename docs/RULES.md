# Civitai 填充 · 映射规则规范（API 版本 1）

映射规则是一个 JS 模块：读取 Civitai 作品的解析结果（report），把参数写进当前 ComfyUI 工作流。
规则不直接改画布，而是通过 `wf`（工作流接口）和 `h`（辅助函数）记录一组修改；插件先展示
修改预览，用户点「应用」后才一次性写入画布（可撤销）。同一份规则也用于 AI / MCP 的试运行。

## 文件格式

```js
// @name SD 基础文生图
// @description 默认文生图模板：提示词、采样参数、尺寸、checkpoint、LoRA 链
export function match(wf, report) {
  // 0~1：这个规则有多适合当前工作流；0 表示不适用。用于自动选择规则。
  return wf.has('KSampler') && wf.has('CheckpointLoaderSimple') ? 0.6 : 0;
}

export default function apply(report, wf, h) {
  const p = h.params();
  const sampler = wf.one('KSampler');
  sampler.set({ seed: p.seed, steps: p.steps, cfg: p.cfg, sampler_name: p.sampler, scheduler: p.scheduler });
  h.positive(sampler)?.set('text', p.prompt);
  h.negative(sampler)?.set('text', p.negative_prompt);
  wf.one('EmptyLatentImage')?.set({ width: h.round(p.width, 8), height: h.round(p.height, 8) });
  const ckpt = wf.one('CheckpointLoaderSimple');
  ckpt?.set('ckpt_name', h.model(h.checkpoint(), 'checkpoints'));
  h.loraChain({ after: ckpt, loras: h.loras() });
}
```

- 文件开头的 `// @name` 和 `// @description` 是规则列表显示的名称和说明（必填 `@name`）。
- `match` 可省略（视为 0.1，即可手动选择但不自动优先）。
- `apply` 是默认导出，可以是 async。返回值忽略。
- 规则必须自包含：不能 `import` 其他模块，不能访问 DOM、网络、ComfyUI 的 `app`。
  规则在 Web Worker 中运行，超时 5 秒。规则是代码：只运行你信任的规则，AI 生成的规则保存前会展示代码。
- 值为 `undefined` 或 `null` 的 `set` 会被忽略，所以 Civitai 没有公开的参数不会覆盖工作流现有值。

## report：解析结果

来自 MaiHub「Civitai 资源解析」（schemaVersion 1）。常用字段：

```js
{
  sourceUrl: 'https://civitai.com/images/123', imageId: '123', mediaType: 'image' | 'video',
  checkpoints: [{ name, versionId, versionName, baseModel, url, available, hash? }],
  loras: [{ name, versionId, baseModel, url, strength /* null = 作者未公开 */, requiresReview,
            usages: [{ node, slot, strength, clipStrength? }] }],
  generation: {
    selectedStage: 's1',
    stages: [{ id, label, parameters: {
      prompt, negative_prompt, seed, steps, cfg, sampler, scheduler, width, height, denoise, guidance? },
      loraNodes: ['24'], components: { vae: 'xxx.safetensors', text_encoder: '...', ... }, requiresImage }],
  },
  media: { type: 'image' | 'video', url, width, height,
           frames: [{ position: 'image' | 'first' | 'last', reference: 'maihub-asset:…' }] },
  warnings: [ '…' ],
}
```

`sampler` / `scheduler` 已规范为 ComfyUI 名称（如 `dpmpp_2m`、`karras`）。多阶段工作流（如高清修复）
在 `stages` 中各有一组参数，`selectedStage` 是默认选中的阶段。

## wf：工作流接口

| 方法 | 说明 |
|---|---|
| `wf.nodes(filter?)` | 节点数组。`filter` 可以是类型字符串、`{ type, title, id }` 或函数 `node => boolean` |
| `wf.one(filter)` | 第一个匹配的节点或 `null`；匹配多个时记录提醒 |
| `wf.has(type)` | 是否存在该类型节点 |
| `wf.add(type, { title?, widgets?, near? })` | 新增节点（按 ComfyUI 节点定义生成控件），`near` 为放置参考节点 |
| `wf.connect(from, output, to, input)` | 连线；`output` 为输出名或序号，`input` 为输入名；会替换该输入原有连线 |

节点对象 `node`：

| 成员 | 说明 |
|---|---|
| `node.id` / `node.type` / `node.title` | 节点 ID、类型、标题（新节点 ID 形如 `new:1`） |
| `node.widgets` | 控件名数组 |
| `node.inputs` / `node.outputs` | 连线输入名 / 输出名数组 |
| `node.bypassed` | 是否已旁路 |
| `node.get(name)` | 控件当前值（含本次规则已做的修改） |
| `node.set(name, value)` / `node.set({ name: value, … })` | 写控件。下拉框的值必须在可选列表中；数值超出范围会提醒；不存在的控件会提醒并跳过 |
| `node.input(name)` | 该输入连接的上游节点或 `null` |
| `node.consumers(output)` | 该输出的下游：`[{ node, input }]` |
| `node.bypass(on = true)` | 旁路 / 恢复该节点 |

## h：辅助函数

| 函数 | 说明 |
|---|---|
| `h.stage(id?)` | 生成阶段（默认 `selectedStage`） |
| `h.params(id?)` | 该阶段的参数对象（没有时为 `{}`） |
| `h.round(value, multiple = 8)` | 取整到倍数（尺寸常用） |
| `h.checkpoint()` | report 中的第一个 checkpoint 资源 |
| `h.model(resource, folder)` | 在本机模型列表（`checkpoints`、`loras`、`vae`、`diffusion_models`、`text_encoders`…）中找对应文件：文件名含版本 ID、或名称匹配。找不到返回 `null` 并记入「缺少的模型」 |
| `h.file(name, folder)` | 按文件名在本机模型列表中查找（用于 `stage.components` 里的 VAE、文本编码器等） |
| `h.loras(stageId?)` | 要应用的 LoRA：`[{ name, versionId, file, strength, clipStrength, requiresReview }]`，已匹配本机文件；权重取该阶段实际用量，未公开时为 1 并提醒核对 |
| `h.loraChain({ after, loras, clip = true, type })` | 在 `after`（模型加载节点）后建立 LoRA 链：复用已有的 LoRA 节点、不够时新增、多余的旁路，并把原下游改接到链末尾。`clip: false` 或 `type: 'LoraLoaderModelOnly'` 只作用于模型 |
| `h.positive(sampler)` / `h.negative(sampler)` | 沿采样器的 `positive` / `negative`（或 guider 的 `conditioning`）往上找文本编码节点 |
| `h.image(position = 'image')` | 作品图片：`'image'`（图片作品）、`'first'` / `'last'`（视频首尾帧）。写到 LoadImage 的 `image` 控件时，应用时自动下载到 ComfyUI 的 input 目录 |
| `h.warn(text)` / `h.note(text)` | 记录提醒 / 说明，显示在预览中 |

## 结果与预览

规则运行后得到：

```js
{ ops: [ { op: 'set', node, widget, value, old }, { op: 'add', ref, type, title, near },
         { op: 'connect', from, output, to, input }, { op: 'mode', node, mode }, { op: 'image', node, widget, reference } ],
  warnings: [ '…' ], notes: [ '…' ], missing: [ { folder, name, versionId, url } ] }
```

预览列出每个节点的修改（旧值 → 新值）、新增节点和连线、缺少的模型（附 Civitai 链接）和提醒。

## 编写建议（给 AI 和人）

1. 先用 `get_current_workflow` 看节点类型、标题、控件名和连线；控件名以快照为准，不要猜。
2. 优先通过连线定位节点（如 `h.positive(sampler)`），而不是依赖节点 ID，规则才能复用到同类工作流。
3. 多个同类节点时用 `title` 或连线区分（如高清修复的第二个 KSampler 用第二阶段参数 `h.params(stage.id)`）。
4. 只设置 report 里有的参数；不要编造值。
5. 写完先试运行，确认没有提醒「控件不存在」「下拉框没有该值」，再保存。
