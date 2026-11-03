import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRun, runRule, ruleHeader, ruleSourceProblems } from '../web/facade.js';
import * as generic from '../rules/generic.js';
import { defaultWorkflow, fluxWorkflow, report, graph, DEFS, MODELS } from './fixtures.mjs';

const sets = result => Object.fromEntries(result.ops.filter(o => o.op === 'set').map(o => [`${o.node}.${o.widget}`, o.value]));

test('the built-in rule fills the default text-to-image workflow and inserts a LoRA chain', async () => {
  const result = await runRule(generic, defaultWorkflow(), report());
  assert.equal(result.score, 0.5);
  const values = sets(result);
  assert.equal(values['3.seed'], 7); assert.equal(values['3.steps'], 25); assert.equal(values['3.cfg'], 6.5);
  assert.equal(values['3.sampler_name'], 'dpmpp_2m'); assert.equal(values['3.scheduler'], 'karras');
  assert.equal(values['3.denoise'], undefined, 'text-to-image keeps denoise 1');
  assert.equal(values['6.text'], 'a lighthouse'); assert.equal(values['7.text'], 'blurry');
  assert.equal(values['5.width'], 768, 'rounded to a multiple of 8'); assert.equal(values['5.height'], 1024);
  assert.equal(values['4.ckpt_name'], 'maihub/dreamshaper_8_128713.safetensors', 'matched by Civitai version ID');
  // One LoRA node after the checkpoint; the sampler and both text encoders now read from it.
  const add = result.ops.find(o => o.op === 'add');
  assert.equal(add.type, 'LoraLoader'); assert.equal(add.near, 4);
  assert.equal(values[`${add.ref}.lora_name`], 'maihub/detail_4567.safetensors'); assert.equal(values[`${add.ref}.strength_model`], 0.6);
  const connects = result.ops.filter(o => o.op === 'connect').map(o => `${o.from}.${o.outputName}->${o.to}.${o.input}`);
  assert.deepEqual(connects.sort(), [`${add.ref}.CLIP->6.clip`, `${add.ref}.CLIP->7.clip`, `${add.ref}.MODEL->3.model`, `4.CLIP->${add.ref}.clip`, `4.MODEL->${add.ref}.model`].sort());
  assert.deepEqual(result.missing.map(m => [m.folder, m.versionId]), [['loras', '999']], 'the absent LoRA is listed, not set');
  assert.match(result.notes.join(' '), /新增 1 个/);
});

test('LoRA nodes already in the workflow are reused, extra ones bypassed', async () => {
  const lora = (id, title) => ({ id, type: 'LoraLoader', title, inputs: [{ name: 'model', type: 'MODEL', link: null }, { name: 'clip', type: 'CLIP', link: null }],
    outputs: [{ name: 'MODEL', type: 'MODEL', links: [] }, { name: 'CLIP', type: 'CLIP', links: [] }],
    widgets: [{ name: 'lora_name', type: 'combo', value: 'style.safetensors', values: MODELS.loras }, { name: 'strength_model', type: 'number', value: 1 }, { name: 'strength_clip', type: 'number', value: 1 }] });
  const snapshot = defaultWorkflow([lora(20, 'A'), lora(21, 'B')], [[4, 0, 20, 'model'], [4, 1, 20, 'clip'], [20, 0, 21, 'model'], [20, 1, 21, 'clip'],
    [21, 0, 3, 'model'], [21, 1, 6, 'clip'], [21, 1, 7, 'clip'], [6, 0, 3, 'positive'], [7, 0, 3, 'negative'], [5, 0, 3, 'latent_image'], [3, 0, 8, 'samples'], [4, 2, 8, 'vae'], [8, 0, 9, 'images']]);
  const result = await runRule(generic, snapshot, report());
  assert.equal(sets(result)['20.lora_name'], 'maihub/detail_4567.safetensors');
  assert.deepEqual(result.ops.filter(o => o.op === 'add' || o.op === 'connect'), [], 'no new nodes or links');
  assert.deepEqual(result.ops.filter(o => o.op === 'mode').map(o => [o.node, o.mode]), [[21, 4]]);
});

test('a FLUX custom-sampler workflow gets seed, sampler, scheduler, guidance and size on the right nodes', async () => {
  const result = await runRule(generic, fluxWorkflow(), report({ checkpoints: [{ name: 'FLUX.1 dev', versionId: '1', versionName: 'flux1-dev', url: 'x' }], loras: [] }));
  const values = sets(result);
  assert.equal(values['25.noise_seed'], 7); assert.equal(values['16.sampler_name'], 'dpmpp_2m');
  assert.equal(values['17.steps'], 25); assert.equal(values['17.scheduler'], 'karras'); assert.equal(values['17.denoise'], undefined);
  assert.equal(values['26.guidance'], 3); assert.equal(values['6.text'], 'a lighthouse');
  assert.equal(values['27.width'], 768); assert.equal(values['12.unet_name'], undefined, 'already the matched file');
  assert.deepEqual(result.ops.filter(o => o.op === 'add'), [], 'no LoRAs to add');
});

test('the facade validates widgets, combo values and ranges instead of guessing', () => {
  const run = createRun(defaultWorkflow(), report());
  const sampler = run.wf.one('KSampler');
  sampler.set({ sampler_name: 'nonexistent', steps: 0, seed: '42', missing_widget: 1, cfg: null });
  assert.deepEqual(run.result().ops.map(o => [o.widget, o.value]), [['seed', 42]]);
  assert.equal(run.result().warnings.length, 3);
  assert.equal(sampler.get('seed'), 42, 'reads see earlier writes');
  assert.equal(run.h.positive(sampler).id, 6); assert.equal(run.h.negative(sampler).id, 7);
  assert.equal(run.wf.add('NoSuchNode'), null);
});

test('the work image goes to LoadImage as an image op', () => {
  const load = { id: 30, type: 'LoadImage', outputs: [{ name: 'IMAGE', type: 'IMAGE', links: [] }], widgets: [{ name: 'image', type: 'combo', value: 'example.png', values: ['example.png'] }] };
  const run = createRun({ ...graph([load], []), defs: DEFS, models: MODELS }, report());
  run.wf.one('LoadImage').set('image', run.h.image('image'));
  assert.deepEqual(run.result().ops, [{ op: 'image', node: 30, widget: 'image', reference: 'maihub-asset:11111111-1111-4111-8111-111111111111', old: 'example.png' }]);
  assert.equal(run.h.image('last'), undefined); assert.match(run.result().warnings.join(), /末帧/);
});

test('rule sources need a name and a default export and cannot import', async () => {
  const source = await readFile(new URL('../rules/generic.js', import.meta.url), 'utf8');
  assert.equal(ruleHeader(source).name, '通用文生图 / 图生图'); assert.deepEqual(ruleSourceProblems(source), []);
  assert.deepEqual(ruleSourceProblems('// @name x\nimport a from "https://e.com/a.js";\nexport default function(){}'), ['规则不能 import 其他模块']);
  assert.ok(ruleSourceProblems('export default function(){}').includes('缺少 // @name 头注释'));
  assert.ok(ruleSourceProblems('// @name x\nconst a = 1;').some(p => p.includes('export default')));
});
