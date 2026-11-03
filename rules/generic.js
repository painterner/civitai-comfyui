// @name 通用文生图 / 图生图
// @description KSampler 或 SamplerCustomAdvanced 工作流：提示词、种子、步数、CFG、采样器、尺寸、checkpoint / UNET、VAE、文本编码器、LoRA 链、输入图片；两个采样器时第二个用第二阶段参数
const SAMPLERS = ['KSampler', 'KSamplerAdvanced', 'SamplerCustomAdvanced'];
const LOADERS = { CheckpointLoaderSimple: ['ckpt_name', 'checkpoints'], UNETLoader: ['unet_name', 'diffusion_models'] };

export function match(wf) {
  if (!SAMPLERS.some(type => wf.has(type))) return 0;
  return Object.keys(LOADERS).some(type => wf.has(type)) ? 0.5 : 0.3;
}

// Sets only the widgets this node has (KSampler has seed, KSamplerAdvanced noise_seed, …).
const setOwn = (node, values) => node && node.set(Object.fromEntries(Object.entries(values).filter(([name]) => node.widgets.includes(name))));

// Upstream walk through link inputs: is `target` an ancestor of `node`?
function dependsOn(node, target, seen = new Set()) {
  if (!node || seen.has(node.id)) return false;
  seen.add(node.id);
  return node.inputs.some(name => { const up = node.input(name); return up && (up.id === target.id || dependsOn(up, target, seen)); });
}

function modelLoader(node) {
  for (let current = node, depth = 0; current && depth < 12; depth++) {
    if (LOADERS[current.type]) return current;
    current = current.input('model');
  }
  return null;
}

function applySampler(sampler, p, h, imageToImage) {
  if (sampler.type === 'SamplerCustomAdvanced') {
    setOwn(sampler.input('noise'), { noise_seed: p.seed });
    setOwn(sampler.input('sampler'), { sampler_name: p.sampler });
    setOwn(sampler.input('sigmas'), { steps: p.steps, scheduler: p.scheduler, ...(imageToImage ? { denoise: p.denoise } : {}) });
    setOwn(sampler.input('guider'), { cfg: p.cfg });
  } else {
    setOwn(sampler, { seed: p.seed, noise_seed: p.seed, steps: p.steps, cfg: p.cfg, sampler_name: p.sampler, scheduler: p.scheduler,
      ...(imageToImage ? { denoise: p.denoise } : {}) });
  }
  const positive = h.positive(sampler), negative = h.negative(sampler);
  setOwn(positive, { text: p.prompt, prompt: p.prompt });
  if (negative && negative.id !== positive?.id) setOwn(negative, { text: p.negative_prompt, prompt: p.negative_prompt });
  // FLUX-style guidance sits between the text encoder and the sampler.
  for (const name of ['positive', 'conditioning']) {
    const guidance = (sampler.input(name) ?? sampler.input('guider')?.input(name));
    if (guidance?.type === 'FluxGuidance') setOwn(guidance, { guidance: p.guidance });
  }
}

export default function apply(report, wf, h) {
  const samplers = wf.nodes(node => SAMPLERS.includes(node.type) && !node.bypassed);
  if (!samplers.length) return h.warn('没有找到采样器节点（KSampler / SamplerCustomAdvanced）');
  // Pipeline order: a sampler fed (through latents) by another one runs after it.
  const ordered = [...samplers].sort((a, b) => (dependsOn(a, b) ? 1 : dependsOn(b, a) ? -1 : 0));
  const stages = report.generation?.stages ?? [];
  const selected = stages.findIndex(stage => stage.id === report.generation?.selectedStage);
  ordered.forEach((sampler, index) => {
    const stage = ordered.length > 1 && stages.length > 1 ? stages[Math.min(index, stages.length - 1)] : stages[Math.max(selected, 0)];
    const latent = sampler.input('latent_image');
    const imageToImage = index > 0 || latent?.type === 'VAEEncode' || !!stage?.requiresImage;
    applySampler(sampler, stage?.parameters ?? {}, h, imageToImage);
    if (index === 0 && latent && latent.widgets.includes('width'))
      setOwn(latent, { width: h.round(stage?.parameters?.width, 8), height: h.round(stage?.parameters?.height, 8) });
  });

  const first = ordered[0];
  const loader = modelLoader(first.input('model') ?? first.input('guider')?.input('model'));
  if (loader) {
    const [widget, folder] = LOADERS[loader.type];
    loader.set(widget, h.model(h.checkpoint(), folder));
    h.loraChain({ after: loader, loras: h.loras(), clip: loader.outputs.includes('CLIP') });
  } else h.warn('没有找到 checkpoint / UNET 加载节点，未替换模型和 LoRA');

  // Split-weight components named by the original workflow.
  const components = h.stage()?.components ?? {};
  setOwn(wf.one('VAELoader'), { vae_name: h.file(components.vae, 'vae') });
  setOwn(wf.one('CLIPLoader'), { clip_name: h.file(components.text_encoder, 'text_encoders') });
  setOwn(wf.one('DualCLIPLoader'), { clip_name1: h.file(components.text_encoder, 'text_encoders'), clip_name2: h.file(components.text_encoder_2, 'text_encoders') });

  // The work itself as the input image of an image-to-image workflow.
  const load = wf.one('LoadImage');
  if (load) load.set('image', h.image(report.mediaType === 'video' ? 'first' : 'image'));
}
