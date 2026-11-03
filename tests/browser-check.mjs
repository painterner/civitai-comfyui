// Real ComfyUI + the dedicated test browser: parse → preview → apply → undo, MCP through the open tab,
// 「AI 生成规则」→「让 AI 修正」→ save, and a work image into LoadImage. Expects the plugin's settings to point
// at a MaiHub (or fake) whose report fits ComfyUI's default workflow (tests/fixtures.mjs report()).
//   node tests/browser-check.mjs --cdp /path/to/browser-automate/scripts/cdp.mjs [--comfy http://127.0.0.1:8188] [--ai] [--screenshot out.png]
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { cdp: { type: 'string' }, comfy: { type: 'string', default: 'http://127.0.0.1:8188' },
  url: { type: 'string', default: 'https://civitai.com/images/1' }, ai: { type: 'boolean' }, screenshot: { type: 'string' } } });
assert.ok(values.cdp, 'Pass --cdp /path/to/browser-automate/scripts/cdp.mjs');
process.env.BROWSER_AUTOMATE_STATE_DIR ??= join(process.env.XDG_RUNTIME_DIR || join(homedir(), '.cache'), 'browser-automate-workspace', 'broker');
const { connect } = await import(pathToFileURL(resolve(values.cdp)).href);
const comfy = values.comfy.replace(/\/$/, '');
const mcp = async (name, args = {}) => {
  const response = await fetch(comfy + '/civitai-fill/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
  const { result } = await response.json();
  if (result.isError) throw new Error(`${name}: ${result.content[0].text}`);
  return JSON.parse(result.content[0].text);
};
const A = 'window.app';
const widget = (type, name) => `(${A}.graph._nodes.find(n=>n.type===${JSON.stringify(type)})?.widgets?.find(w=>w.name===${JSON.stringify(name)})?.value)`;
const report = {};
const CLASSIC = {
  3: { class_type: 'KSampler', inputs: { seed: 1, steps: 20, cfg: 8, sampler_name: 'euler', scheduler: 'normal', denoise: 1, model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0] } },
  4: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'v1-5-pruned-emaonly.safetensors' } },
  5: { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512, batch_size: 1 } },
  6: { class_type: 'CLIPTextEncode', inputs: { text: 'old positive', clip: ['4', 1] } },
  7: { class_type: 'CLIPTextEncode', inputs: { text: 'old negative', clip: ['4', 1] } },
  8: { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
  9: { class_type: 'SaveImage', inputs: { images: ['8', 0], filename_prefix: 'ComfyUI' } },
};

const browser = await connect(), { browserContextId } = await browser.cdp('Target.createBrowserContext');
try {
  const { targetId } = await browser.cdp('Target.createTarget', { url: comfy + '/', browserContextId });
  const tab = await browser.tab(targetId); await tab.activate();
  await tab.wait(`!!${A}?.graph && ${A}.graph._nodes.some(n=>n.type==='KSampler') && !!${A}.extensionManager?.command`, { timeout: 90000 });
  // The classic SD 1.5 text-to-image graph, whatever this ComfyUI's default workflow is.
  await tab.eval(`${A}.loadApiJson(${JSON.stringify(CLASSIC)}, 'civitai-fill-browser-check')`);
  await tab.wait(`${A}.graph._nodes.length===7 && ${widget('KSampler', 'steps')}===20`, { timeout: 30000 });
  const original = { steps: await tab.eval(widget('KSampler', 'steps')), ckpt: await tab.eval(widget('CheckpointLoaderSimple', 'ckpt_name')) };
  await tab.eval(`${A}.extensionManager.command.execute('Workspace.ToggleSidebarTab.civitai-fill')`);
  await tab.wait(`document.querySelectorAll('#cf-rule option').length>0 && !document.querySelector('#cf-inspect').disabled`, { timeout: 30000 });

  // Parse, then preview.
  await tab.eval(`(()=>{const i=document.querySelector('#cf-url');i.value=${JSON.stringify(values.url)};document.querySelector('#cf-inspect').click();})()`);
  await tab.wait(`document.querySelector('#cf-report')?.textContent.includes('checkpoint') && !document.querySelector('#cf-inspect').disabled`, { timeout: 60000 });
  report.rule = await tab.eval(`document.querySelector('#cf-rule').selectedOptions[0].textContent`);
  await tab.eval(`document.querySelector('#cf-preview').click()`);
  await tab.wait(`document.querySelector('#cf-result h3')?.textContent.startsWith('修改预览')`, { timeout: 30000 });
  report.preview = await tab.eval(`document.querySelector('#cf-result').innerText`);
  assert.match(report.preview, /steps 20 → 25/); assert.match(report.preview, /本机缺少的模型/);
  assert.equal(await tab.eval(widget('KSampler', 'steps')), original.steps, 'preview changes nothing');

  // Apply, check the live graph, undo.
  await tab.eval(`document.querySelector('#cf-apply').click()`);
  await tab.wait(`document.querySelector('#cf-result h3')?.textContent.startsWith('已应用')`, { timeout: 30000 });
  const applied = await tab.eval(`(()=>{const g=${A}.graph,n=t=>g._nodes.filter(x=>x.type===t),k=n('KSampler')[0],lora=n('LoraLoader')[0];
    const link=id=>g.links instanceof Map?g.links.get(id):g.links[id];
    return {steps:k.widgets.find(w=>w.name==='steps').value,seed:k.widgets.find(w=>w.name==='seed').value,sampler:k.widgets.find(w=>w.name==='sampler_name').value,
      text:n('CLIPTextEncode').map(c=>c.widgets[0].value),ckpt:n('CheckpointLoaderSimple')[0].widgets[0].value,width:n('EmptyLatentImage')[0].widgets[0].value,
      lora:lora&&lora.widgets.find(w=>w.name==='lora_name').value,samplerModelFrom:link(k.inputs.find(i=>i.name==='model').link)?.origin_id===lora?.id,
      extra:g.extra?.civitaiFill?.rule};})()`);
  assert.deepEqual({ ...applied, text: applied.text.sort() }, { steps: 25, seed: 7, sampler: 'dpmpp_2m', text: ['a lighthouse', 'blurry'].sort(),
    ckpt: 'maihub/dreamshaper_8_128713.safetensors', width: 768, lora: 'maihub/detail_4567.safetensors', samplerModelFrom: true, extra: 'generic' });
  await tab.eval(`${A}.extensionManager.command.execute('Comfy.Undo')`);
  await tab.wait(`${widget('KSampler', 'steps')}===${original.steps} && !${A}.graph._nodes.some(n=>n.type==='LoraLoader')`, { timeout: 15000 });
  report.undo = 'one step restored the workflow';

  // Agents through the open tab (MCP).
  const snapshot = await mcp('get_current_workflow');
  assert.ok(snapshot.nodes.some(n => n.type === 'KSampler') && snapshot.models.loras.length > 0);
  const inspected = await mcp('civitai_inspect', { url: values.url });
  const dry = await mcp('dry_run_rule', { id: 'generic', report: inspected });
  assert.ok(dry.ops.length > 5 && dry.missing.length === 1);
  assert.equal(await tab.eval(widget('KSampler', 'steps')), original.steps, 'an MCP dry run changes nothing');
  await mcp('apply_rule', { id: 'generic', url: values.url });
  await tab.wait(`${widget('KSampler', 'steps')}===25`, { timeout: 15000 });
  await tab.eval(`${A}.extensionManager.command.execute('Comfy.Undo')`);
  await tab.wait(`${widget('KSampler', 'steps')}===${original.steps}`, { timeout: 15000 });
  report.mcp = { snapshotNodes: snapshot.nodes.length, dryRunOps: dry.ops.length, applied: true };

  // A work image into an image-to-image workflow's LoadImage.
  await tab.eval(`(()=>{const node=LiteGraph.createNode('LoadImage');node.pos=[0,600];${A}.graph.add(node);})()`);
  await tab.eval(`document.querySelector('#cf-apply').click()`);
  await tab.wait(`String(${widget('LoadImage', 'image')}).startsWith('civitai/')`, { timeout: 30000 });
  const image = await tab.eval(widget('LoadImage', 'image'));
  const view = await fetch(`${comfy}/view?filename=${encodeURIComponent(image.split('/')[1])}&subfolder=civitai&type=input`);
  assert.equal(view.status, 200, 'the work image is in ComfyUI input');
  report.image = image;

  if (values.ai) {
    await tab.eval(`(()=>{document.querySelector('#cf-ai').open=true;document.querySelector('#cf-ai-generate').click();})()`);
    await tab.wait(`/问题|已试运行/.test(document.querySelector('#cf-ai-status').textContent) && !document.querySelector('#cf-ai-fix').disabled`, { timeout: 60000 });
    report.aiFirst = await tab.eval(`document.querySelector('#cf-ai-status').textContent`);
    if (/问题/.test(report.aiFirst)) {
      await tab.eval(`document.querySelector('#cf-ai-fix').click()`);
      await tab.wait(`/已试运行|规则如下/.test(document.querySelector('#cf-ai-status').textContent) && !document.querySelector('#cf-ai-fix').disabled`, { timeout: 60000 });
    }
    report.aiFixed = await tab.eval(`document.querySelector('#cf-ai-status').textContent`);
    await tab.eval(`(()=>{document.querySelector('#cf-rule-id').value='browser-check-ai';document.querySelector('#cf-code-save').click();})()`);
    await tab.wait(`[...document.querySelectorAll('#cf-rule option')].some(o=>o.value==='browser-check-ai')`, { timeout: 30000 });
    report.aiSaved = (await mcp('list_rules')).some(r => r.id === 'browser-check-ai');
    await fetch(comfy + '/civitai-fill/rules/browser-check-ai', { method: 'DELETE' });
  }
  if (values.screenshot) {
    await tab.eval(`document.querySelector('#cf-settings').open=false`);
    const shot = await tab.send('Page.captureScreenshot', { format: 'png' });
    await writeFile(values.screenshot, Buffer.from(shot.data, 'base64'));
  }
  console.log(JSON.stringify({ ...report, preview: report.preview.split('\n').slice(0, 6) }, null, 2));
} finally { await browser.cdp('Target.disposeBrowserContext', { browserContextId }); }
