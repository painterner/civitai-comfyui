---
name: civitai-comfyui-rules
description: Write, test and save mapping rules for the ComfyUI plugin "Civitai 填充" (civitai-comfyui), which fills a ComfyUI workflow with a Civitai work's checkpoint, LoRAs and generation parameters. Use when asked to make Civitai parameters apply to a specific ComfyUI workflow, to create or fix a civitai-fill rule, or to fill the open workflow from a Civitai image URL.
---

# Civitai 填充 rules

The plugin runs inside ComfyUI. Its tools are on the ComfyUI server as MCP (`POST <comfy>/civitai-fill/mcp`,
streamable HTTP) and as HTTP endpoints under `<comfy>/civitai-fill/`. Tools that read or change the workflow are
executed by the user's open ComfyUI browser tab; if they fail with "没有打开的 ComfyUI 页面", ask the user to open ComfyUI.

## Workflow

1. `civitai_rule_spec` — read the rule format and the `wf` / `h` API once. Follow it exactly; do not invent helpers.
2. `civitai_workflow_snapshot` — node types, titles, widget names and values, links (`inputs[].from = "nodeId:slot"`),
   and local model lists. Widget names come from here, not from memory.
3. `civitai_inspect(url)` if you have a Civitai URL — the report the rule will receive. Without one, write the rule
   against the report schema in the spec.
4. Write the rule: `// @name …` and `// @description …` header, `match(wf)` returning 0–1 for this kind of workflow,
   `export default function apply(report, wf, h)`. Locate nodes through links (`h.positive(sampler)`,
   `node.input('model')`, `node.consumers('MODEL')`) rather than node IDs so the rule fits similar workflows.
   Set only values the report has; `set(name, undefined)` is ignored by design.
5. `civitai_dry_run_rule({source, url | report})` — fix every warning about missing widgets, combo values, inputs/outputs or
   node types, then run again until clean. `missing` lists models the user does not have; that is information, not an error.
6. `civitai_save_rule({id, source})` — lowercase id with `-`, e.g. `flux-hires`. Built-in ids cannot be overwritten.
7. Only if the user asked to fill the workflow: `civitai_apply_rule({id, url})`. It changes their open workflow (one undo step).

## Rules of thumb

- Several samplers: order them by dependency (a sampler fed by another runs after it) and give later ones the later
  stage's parameters (`h.params(stage.id)`); only set `denoise` for image-to-image or a second pass.
- LoRAs: `h.loraChain({ after: loader, loras: h.loras(), clip: loader.outputs.includes('CLIP') })` reuses existing
  LoRA nodes, adds missing ones and bypasses extras.
- Sizes: `h.round(p.width, 8)` (or the model's multiple, e.g. 16 or 32).
- Input image of an image-to-image workflow: `loadImage.set('image', h.image(report.mediaType === 'video' ? 'first' : 'image'))`.
- Rules run in a Web Worker without network or DOM, cannot `import`, and must finish within 5 seconds.
