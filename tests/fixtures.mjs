// Snapshots as the panel takes them from the live graph, and an inspect report as MaiHub returns it.
const SAMPLERS = ['euler', 'euler_ancestral', 'dpmpp_2m', 'dpmpp_2m_sde'], SCHEDULERS = ['normal', 'karras', 'simple'];
const number = (name, value, min = 0, max = 1e18) => ({ name, type: 'number', value, min, max });
const combo = (name, value, values) => ({ name, type: 'combo', value, values });
let linkId = 0;
export function graph(nodes, connections) {
  const byId = new Map(nodes.map(n => [n.id, { ...n, mode: n.mode ?? 0, title: n.title ?? n.type, inputs: n.inputs ?? [], outputs: n.outputs ?? [], widgets: n.widgets ?? [] }]));
  const links = [];
  for (const [from, fromSlot, to, input] of connections) {
    const target = byId.get(to), slot = target.inputs.findIndex(i => i.name === input), id = ++linkId;
    links.push({ id, from, fromSlot, to, toSlot: slot, type: byId.get(from).outputs[fromSlot].type });
    target.inputs[slot].link = id;
    byId.get(from).outputs[fromSlot].links.push(id);
  }
  return { nodes: [...byId.values()], links };
}
const inp = (name, type) => ({ name, type, link: null }), out = (name, type = name) => ({ name, type, links: [] });

export const DEFS = {
  LoraLoader: { input: { required: { model: ['MODEL'], clip: ['CLIP'], lora_name: [['style.safetensors', 'maihub/detail_4567.safetensors']],
    strength_model: ['FLOAT', { default: 1, min: -100, max: 100 }], strength_clip: ['FLOAT', { default: 1, min: -100, max: 100 }] } },
    output: ['MODEL', 'CLIP'], output_name: ['MODEL', 'CLIP'], display_name: 'Load LoRA' },
  LoraLoaderModelOnly: { input: { required: { model: ['MODEL'], lora_name: [['style.safetensors', 'maihub/detail_4567.safetensors']],
    strength_model: ['FLOAT', { default: 1, min: -100, max: 100 }] } }, output: ['MODEL'], output_name: ['MODEL'] },
};
export const MODELS = { checkpoints: ['v1-5-pruned-emaonly.safetensors', 'maihub/dreamshaper_8_128713.safetensors'],
  loras: ['style.safetensors', 'maihub/detail_4567.safetensors'], vae: ['ae.safetensors'], text_encoders: ['clip_l.safetensors', 't5xxl_fp16.safetensors'],
  diffusion_models: ['flux1-dev.safetensors'] };

// ComfyUI's default text-to-image workflow.
export function defaultWorkflow(extraNodes = [], extraConnections = null) {
  const nodes = [
    { id: 4, type: 'CheckpointLoaderSimple', title: 'Load Checkpoint', outputs: [out('MODEL'), out('CLIP'), out('VAE')],
      widgets: [combo('ckpt_name', 'v1-5-pruned-emaonly.safetensors', MODELS.checkpoints)] },
    { id: 6, type: 'CLIPTextEncode', title: 'CLIP Text Encode (Prompt)', inputs: [inp('clip', 'CLIP')], outputs: [out('CONDITIONING')], widgets: [{ name: 'text', type: 'customtext', value: 'old positive' }] },
    { id: 7, type: 'CLIPTextEncode', title: 'CLIP Text Encode (Prompt)', inputs: [inp('clip', 'CLIP')], outputs: [out('CONDITIONING')], widgets: [{ name: 'text', type: 'customtext', value: 'old negative' }] },
    { id: 5, type: 'EmptyLatentImage', outputs: [out('LATENT')], widgets: [number('width', 512, 16, 16384), number('height', 512, 16, 16384), number('batch_size', 1, 1, 4096)] },
    { id: 3, type: 'KSampler', inputs: [inp('model', 'MODEL'), inp('positive', 'CONDITIONING'), inp('negative', 'CONDITIONING'), inp('latent_image', 'LATENT')],
      outputs: [out('LATENT')], widgets: [number('seed', 1), combo('control_after_generate', 'randomize', ['fixed', 'randomize']), number('steps', 20, 1, 10000),
        number('cfg', 8, 0, 100), combo('sampler_name', 'euler', SAMPLERS), combo('scheduler', 'normal', SCHEDULERS), number('denoise', 1, 0, 1)] },
    { id: 8, type: 'VAEDecode', inputs: [inp('samples', 'LATENT'), inp('vae', 'VAE')], outputs: [out('IMAGE')] },
    { id: 9, type: 'SaveImage', inputs: [inp('images', 'IMAGE')], widgets: [{ name: 'filename_prefix', type: 'text', value: 'ComfyUI' }] },
    ...extraNodes,
  ];
  return { ...graph(nodes, extraConnections ?? [[4, 0, 3, 'model'], [4, 1, 6, 'clip'], [4, 1, 7, 'clip'], [6, 0, 3, 'positive'], [7, 0, 3, 'negative'],
    [5, 0, 3, 'latent_image'], [3, 0, 8, 'samples'], [4, 2, 8, 'vae'], [8, 0, 9, 'images']]), defs: DEFS, models: MODELS };
}

// A FLUX-style custom sampler workflow.
export function fluxWorkflow() {
  const nodes = [
    { id: 12, type: 'UNETLoader', outputs: [out('MODEL')], widgets: [combo('unet_name', 'flux1-dev.safetensors', MODELS.diffusion_models), combo('weight_dtype', 'default', ['default'])] },
    { id: 11, type: 'DualCLIPLoader', outputs: [out('CLIP')], widgets: [combo('clip_name1', 't5xxl_fp16.safetensors', MODELS.text_encoders), combo('clip_name2', 'clip_l.safetensors', MODELS.text_encoders), combo('type', 'flux', ['flux'])] },
    { id: 10, type: 'VAELoader', outputs: [out('VAE')], widgets: [combo('vae_name', 'ae.safetensors', MODELS.vae)] },
    { id: 6, type: 'CLIPTextEncode', inputs: [inp('clip', 'CLIP')], outputs: [out('CONDITIONING')], widgets: [{ name: 'text', type: 'customtext', value: 'old' }] },
    { id: 26, type: 'FluxGuidance', inputs: [inp('conditioning', 'CONDITIONING')], outputs: [out('CONDITIONING')], widgets: [number('guidance', 3.5, 0, 100)] },
    { id: 22, type: 'BasicGuider', inputs: [inp('model', 'MODEL'), inp('conditioning', 'CONDITIONING')], outputs: [out('GUIDER')] },
    { id: 25, type: 'RandomNoise', outputs: [out('NOISE')], widgets: [number('noise_seed', 1)] },
    { id: 16, type: 'KSamplerSelect', outputs: [out('SAMPLER')], widgets: [combo('sampler_name', 'euler', SAMPLERS)] },
    { id: 17, type: 'BasicScheduler', inputs: [inp('model', 'MODEL')], outputs: [out('SIGMAS')], widgets: [combo('scheduler', 'simple', SCHEDULERS), number('steps', 20, 1, 10000), number('denoise', 1, 0, 1)] },
    { id: 27, type: 'EmptySD3LatentImage', outputs: [out('LATENT')], widgets: [number('width', 1024, 16, 16384), number('height', 1024, 16, 16384), number('batch_size', 1, 1, 4096)] },
    { id: 13, type: 'SamplerCustomAdvanced', inputs: [inp('noise', 'NOISE'), inp('guider', 'GUIDER'), inp('sampler', 'SAMPLER'), inp('sigmas', 'SIGMAS'), inp('latent_image', 'LATENT')], outputs: [out('output', 'LATENT'), out('denoised_output', 'LATENT')] },
  ];
  return { ...graph(nodes, [[11, 0, 6, 'clip'], [6, 0, 26, 'conditioning'], [26, 0, 22, 'conditioning'], [12, 0, 22, 'model'], [12, 0, 17, 'model'],
    [25, 0, 13, 'noise'], [22, 0, 13, 'guider'], [16, 0, 13, 'sampler'], [17, 0, 13, 'sigmas'], [27, 0, 13, 'latent_image']]), defs: DEFS, models: MODELS };
}

export function report(overrides = {}) {
  return {
    schemaVersion: 1, sourceUrl: 'https://civitai.com/images/1', imageId: '1', mediaType: 'image',
    checkpoints: [{ name: 'DreamShaper', versionId: '128713', versionName: '8', baseModel: 'SD 1.5', url: 'https://civitai.com/api/download/models/128713', available: true }],
    loras: [{ name: 'Detail Tweaker', versionId: '4567', baseModel: 'SD 1.5', url: 'https://civitai.com/api/download/models/4567', strength: 0.6, usages: [] },
            { name: 'Not Here', versionId: '999', baseModel: 'SD 1.5', url: 'https://civitai.com/api/download/models/999', strength: 0.8, usages: [] }],
    generation: { selectedStage: 's1', stages: [{ id: 's1', label: '阶段 1', parameters: { prompt: 'a lighthouse', negative_prompt: 'blurry', seed: 7, steps: 25, cfg: 6.5,
      sampler: 'dpmpp_2m', scheduler: 'karras', width: 769, height: 1024, denoise: 0.6, guidance: 3 }, loraNodes: [], components: {}, requiresImage: false }] },
    media: { type: 'image', url: 'https://image.civitai.com/x.png', width: 512, height: 768, frames: [{ position: 'image', reference: 'maihub-asset:11111111-1111-4111-8111-111111111111' }] },
    warnings: [], ...overrides,
  };
}
