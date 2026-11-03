// Civitai 填充 rule runtime (docs/RULES.md): a recording facade over a workflow snapshot. Rules read and
// "write" the snapshot through `wf` and `h`; the writes become ops the panel previews and then applies to
// the live graph. Pure ES module, shared by the browser worker and Node tests; it never touches `app`.
export const RULE_API_VERSION = 1;
const BYPASS = 4, ACTIVE = 0;
const LORA_TYPES = ['LoraLoader', 'LoraLoaderModelOnly'];
const WIDGET_TYPES = new Set(['INT', 'FLOAT', 'STRING', 'BOOLEAN', 'COMBO']);

/** @name / @description from a rule's leading comment lines. */
export function ruleHeader(source) {
  const header = {};
  for (const line of String(source).split('\n')) {
    const text = line.trim();
    if (!text) continue;
    if (!text.startsWith('//')) break;
    const match = text.match(/^\/\/\s*@(name|description)\s+(.+)$/);
    if (match) header[match[1]] = match[2].trim();
  }
  return header;
}

/** Problems that stop a rule before it runs (it must be one self-contained module). */
export function ruleSourceProblems(source) {
  const problems = [];
  if (typeof source !== 'string' || !source.trim()) return ['规则为空'];
  if (source.length > 200_000) problems.push('规则超过 200 KB');
  if (/^\s*import[\s{*]/m.test(source) || /\bimport\s*\(/.test(source)) problems.push('规则不能 import 其他模块');
  if (!ruleHeader(source).name) problems.push('缺少 // @name 头注释');
  if (!/export\s+default\s+(async\s+)?function/.test(source) && !/export\s+default\s/.test(source)) problems.push('缺少 export default function apply(report, wf, h)');
  return problems;
}

const clone = value => JSON.parse(JSON.stringify(value));
const basename = name => String(name).split(/[\\/]/).pop();
const stem = name => basename(name).replace(/\.[a-z0-9]+$/i, '');
const squash = text => String(text ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');

/** Widgets / link inputs / outputs of a new node from its ComfyUI definition (object_info). */
function nodeFromDef(id, type, def) {
  const inputs = [], widgets = [];
  for (const group of ['required', 'optional']) {
    for (const [name, spec] of Object.entries(def.input?.[group] ?? {})) {
      const [kind, options = {}] = Array.isArray(spec) ? spec : [spec];
      const values = Array.isArray(kind) ? kind : kind === 'COMBO' ? options.options : undefined;
      if ((Array.isArray(kind) || WIDGET_TYPES.has(kind)) && !options.forceInput) {
        widgets.push({ name, type: values ? 'combo' : kind === 'BOOLEAN' ? 'toggle' : kind === 'STRING' ? 'text' : 'number',
          value: options.default ?? values?.[0] ?? (kind === 'BOOLEAN' ? false : kind === 'STRING' ? '' : 0),
          ...(values ? { values } : {}), ...(options.min !== undefined ? { min: options.min } : {}), ...(options.max !== undefined ? { max: options.max } : {}) });
      } else inputs.push({ name, type: Array.isArray(kind) ? 'COMBO' : String(kind), link: null });
    }
  }
  const outputs = (def.output ?? []).map((kind, index) => ({ name: def.output_name?.[index] ?? String(kind), type: String(kind), links: [] }));
  return { id, type, title: def.display_name ?? type, mode: ACTIVE, inputs, outputs, widgets, isNew: true };
}

/**
 * A rule run over `snapshot` ({nodes, links, defs, models}): returns {wf, h, result()}.
 * Snapshot nodes: {id, type, title, mode, inputs:[{name,type,link}], outputs:[{name,type,links}],
 * widgets:[{name,type,value,values?,min?,max?}]}; links: {id, from, fromSlot, to, toSlot, type}.
 */
export function createRun(snapshot, report = {}) {
  const nodes = new Map((snapshot.nodes ?? []).map(node => [node.id, clone(node)]));
  const links = new Map((snapshot.links ?? []).map(link => [link.id, { ...link }]));
  const defs = snapshot.defs ?? {}, models = snapshot.models ?? {};
  const ops = [], warnings = [], notes = [], missing = [];
  let newNodes = 0, newLinks = 0;
  const warn = text => { if (!warnings.includes(text)) warnings.push(text); };
  const label = node => `${node.title || node.type}（${node.id}）`;
  const refs = new Map();

  function setWidget(node, name, value) {
    if (value === undefined || value === null) return;
    const widget = node.widgets.find(w => w.name === name);
    if (!widget) return warn(`${label(node)} 没有控件 ${name}，已跳过`);
    if (value && typeof value === 'object' && '__civitaiFillImage' in value) {
      ops.push({ op: 'image', node: node.id, widget: name, reference: value.__civitaiFillImage, old: widget.value });
      widget.value = `civitai-fill/${String(value.__civitaiFillImage).replace(/^maihub-asset:/, '')}`;
      return;
    }
    if (widget.type === 'number') {
      const number = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(number)) return warn(`${label(node)} 的 ${name} 需要数值，收到 ${JSON.stringify(value)}`);
      if ((widget.min !== undefined && number < widget.min) || (widget.max !== undefined && number > widget.max))
        return warn(`${label(node)} 的 ${name}=${number} 超出范围 ${widget.min ?? '-∞'}~${widget.max ?? '∞'}，已跳过`);
      value = number;
    } else if (widget.type === 'toggle') value = Boolean(value);
    else if (widget.values) {
      if (!widget.values.includes(value)) return warn(`${label(node)} 的 ${name} 没有可选值「${value}」，已跳过`);
    } else if (typeof value !== 'string') value = String(value);
    if (widget.value === value) return;
    const earlier = ops.find(op => op.op === 'set' && op.node === node.id && op.widget === name);
    if (earlier) earlier.value = value;
    else ops.push({ op: 'set', node: node.id, widget: name, value, old: widget.value });
    widget.value = value;
  }

  function ref(node) {
    if (!node) return null;
    if (refs.has(node.id)) return refs.get(node.id);
    const self = {
      get id() { return node.id; }, get type() { return node.type; }, get title() { return node.title; },
      get isNew() { return !!node.isNew; }, get widgets() { return node.widgets.map(w => w.name); },
      get inputs() { return node.inputs.map(i => i.name); }, get outputs() { return node.outputs.map(o => o.name); },
      get bypassed() { return node.mode === BYPASS; },
      get(name) { return node.widgets.find(w => w.name === name)?.value; },
      set(name, value) {
        if (name && typeof name === 'object') { for (const [key, item] of Object.entries(name)) setWidget(node, key, item); }
        else setWidget(node, name, value);
        return self;
      },
      input(name) {
        const input = node.inputs.find(i => i.name === name);
        const link = input?.link != null ? links.get(input.link) : null;
        return link ? ref(nodes.get(link.from)) : null;
      },
      consumers(output) {
        const slot = typeof output === 'number' ? output : node.outputs.findIndex(o => o.name === output || o.type === output);
        return (node.outputs[slot]?.links ?? []).map(id => links.get(id)).filter(Boolean)
          .map(link => ({ node: ref(nodes.get(link.to)), input: nodes.get(link.to)?.inputs[link.toSlot]?.name }));
      },
      bypass(on = true) {
        const mode = on ? BYPASS : ACTIVE;
        if (node.mode !== mode) { ops.push({ op: 'mode', node: node.id, mode, old: node.mode }); node.mode = mode; }
        return self;
      },
    };
    refs.set(node.id, self);
    return self;
  }

  const matches = (node, filter) => {
    if (!filter) return true;
    if (typeof filter === 'function') return !!filter(ref(node));
    if (typeof filter === 'string') return node.type === filter;
    return (filter.type === undefined || node.type === filter.type) && (filter.title === undefined || node.title === filter.title)
      && (filter.id === undefined || String(node.id) === String(filter.id));
  };

  const wf = {
    nodes(filter) { return [...nodes.values()].filter(node => matches(node, filter)).map(ref); },
    one(filter) {
      const found = wf.nodes(filter);
      if (found.length > 1) warn(`找到 ${found.length} 个匹配 ${typeof filter === 'string' ? filter : JSON.stringify(filter)} 的节点，使用第一个（${found[0].id}）`);
      return found[0] ?? null;
    },
    has(type) { return [...nodes.values()].some(node => node.type === type); },
    add(type, { title, widgets, near } = {}) {
      const def = defs[type];
      if (!def) { warn(`当前 ComfyUI 没有节点类型 ${type}，未新增`); return null; }
      const node = nodeFromDef(`new:${++newNodes}`, type, def);
      if (title) node.title = title;
      nodes.set(node.id, node);
      ops.push({ op: 'add', ref: node.id, type, title: node.title, near: near?.id ?? null });
      const self = ref(node);
      if (widgets) self.set(widgets);
      return self;
    },
    connect(from, output, to, input) {
      if (!from || !to) return warn('连线缺少节点，已跳过');
      const source = nodes.get(from.id), target = nodes.get(to.id);
      const slot = typeof output === 'number' ? output : source.outputs.findIndex(o => o.name === output || o.type === output);
      const inSlot = target.inputs.findIndex(i => i.name === input);
      if (slot < 0 || !source.outputs[slot]) return warn(`${label(source)} 没有输出 ${output}，未连线`);
      if (inSlot < 0) return warn(`${label(target)} 没有输入 ${input}，未连线`);
      const outType = source.outputs[slot].type, inType = target.inputs[inSlot].type;
      if (outType !== inType && outType !== '*' && inType !== '*' && !String(inType).split(',').includes(outType))
        return warn(`${label(source)} 的 ${outType} 输出不能连到 ${label(target)} 的 ${input}（${inType}）`);
      const existing = target.inputs[inSlot].link;
      if (existing != null) {
        const old = links.get(existing);
        if (old && old.from === source.id && old.fromSlot === slot) return;
        if (old) { const upstream = nodes.get(old.from); if (upstream) upstream.outputs[old.fromSlot].links = upstream.outputs[old.fromSlot].links.filter(id => id !== existing); }
        links.delete(existing);
      }
      const id = `newlink:${++newLinks}`;
      links.set(id, { id, from: source.id, fromSlot: slot, to: target.id, toSlot: inSlot, type: outType });
      source.outputs[slot].links.push(id);
      target.inputs[inSlot].link = id;
      ops.push({ op: 'connect', from: source.id, output: slot, outputName: source.outputs[slot].name, to: target.id, input });
    },
  };

  const stage = id => {
    const stages = report.generation?.stages ?? [];
    const wanted = id ?? report.generation?.selectedStage;
    return stages.find(s => s.id === wanted) ?? stages[0] ?? null;
  };
  const record = item => {
    if (!missing.some(m => m.folder === item.folder && m.name === item.name && m.versionId === item.versionId)) missing.push(item);
  };
  const list = folder => {
    if (!models[folder]) warn(`没有 ${folder} 模型列表，无法匹配本机文件`);
    return models[folder] ?? [];
  };
  function model(resource, folder) {
    if (!resource) return null;
    const files = list(folder), version = resource.versionId ? String(resource.versionId) : '';
    const byVersion = version && files.find(file => new RegExp(`(^|[^0-9])${version}([^0-9]|$)`).test(stem(file)));
    const names = [resource.versionName, resource.name].map(squash).filter(name => name.length >= 4);
    const byName = byVersion ? null : files.find(file => names.some(name => squash(stem(file)).includes(name)));
    const found = byVersion || byName;
    if (found) return found;
    record({ folder, name: resource.name ?? null, versionName: resource.versionName ?? null, versionId: resource.versionId ?? null, url: resource.url ?? null });
    return null;
  }
  function file(name, folder) {
    if (!name) return null;
    const files = list(folder);
    const found = files.find(f => f === name) ?? files.find(f => basename(f) === basename(name));
    if (found) return found;
    record({ folder, name, versionName: null, versionId: null, url: null });
    return null;
  }
  // Follow a sampler's positive/negative (or a guider's conditioning) up to the text encoder.
  function conditioning(sampler, which) {
    if (!sampler) return null;
    let start = sampler.input(which);
    if (!start && sampler.input('guider')) {
      const guider = sampler.input('guider');
      start = guider.input(which) ?? (which === 'positive' ? guider.input('conditioning') : null);
    }
    const seen = new Set();
    for (let level = [start].filter(Boolean), depth = 0; level.length && depth < 6; depth++) {
      const next = [];
      for (const node of level) {
        if (seen.has(node.id)) continue;
        seen.add(node.id);
        if (node.widgets.some(name => ['text', 'prompt', 'text_g'].includes(name))) return node;
        for (const input of nodes.get(node.id).inputs) if (input.type === 'CONDITIONING') next.push(node.input(input.name));
      }
      level = next.filter(Boolean);
    }
    return null;
  }

  const h = {
    stage, params: id => stage(id)?.parameters ?? {},
    round: (value, multiple = 8) => typeof value === 'number' && Number.isFinite(value) ? Math.max(multiple, Math.round(value / multiple) * multiple) : value,
    checkpoint: () => (report.checkpoints ?? []).find(c => c.url || c.versionId) ?? report.checkpoints?.[0] ?? null,
    model, file,
    loras(stageId) {
      const current = stage(stageId), chosen = [];
      for (const lora of report.loras ?? []) {
        const usage = lora.usages?.find(u => current?.loraNodes?.includes(u.node) && u.strength != null);
        const strength = usage?.strength ?? lora.strength ?? 1;
        if (strength === 0) continue;
        if (usage == null && lora.strength == null) warn(`LoRA ${lora.name ?? lora.versionId} 作者未公开权重，暂用 1，请核对`);
        const found = model(lora, 'loras');
        if (found) chosen.push({ name: lora.name, versionId: lora.versionId, file: found, strength, clipStrength: usage?.clipStrength ?? strength, requiresReview: !!lora.requiresReview });
      }
      return chosen;
    },
    loraChain({ after, loras = [], clip = true, type } = {}) {
      if (!after) return warn('LoRA 链缺少模型加载节点，未应用 LoRA');
      const node = nodes.get(after.id);
      const modelSlot = node.outputs.findIndex(o => o.type === 'MODEL');
      if (modelSlot < 0) return warn(`${label(node)} 没有 MODEL 输出，未应用 LoRA`);
      const clipSlot = clip ? node.outputs.findIndex(o => o.type === 'CLIP') : -1;
      const kind = type ?? (clipSlot >= 0 ? 'LoraLoader' : 'LoraLoaderModelOnly');
      // The LoRA nodes already chained after the loader, reused in order.
      const chain = [];
      for (let current = after; ;) {
        const next = current.consumers('MODEL');
        if (next.length !== 1 || !LORA_TYPES.includes(next[0].node.type) || next[0].input !== 'model') break;
        chain.push(next[0].node); current = next[0].node;
      }
      const reused = Math.min(chain.length, loras.length);
      let lastModel = chain.length ? chain[chain.length - 1] : after;
      let lastClip = clipSlot < 0 ? null : [...chain].reverse().find(n => n.type === 'LoraLoader' && n.input('clip')) ?? after;
      const downstreamModel = lastModel.consumers('MODEL').filter(c => !LORA_TYPES.includes(c.node.type) || !chain.includes(c.node));
      const downstreamClip = lastClip ? lastClip.consumers('CLIP').filter(c => !chain.includes(c.node)) : [];
      loras.forEach((lora, index) => {
        let target = chain[index];
        if (!target) {
          target = wf.add(kind, { near: lastModel });
          if (!target) return;
          wf.connect(lastModel, 'MODEL', target, 'model');
          if (target.type === 'LoraLoader' && lastClip) wf.connect(lastClip, 'CLIP', target, 'clip');
        }
        target.bypass(false);
        target.set({ lora_name: lora.file, strength_model: lora.strength, ...(target.type === 'LoraLoader' ? { strength_clip: lora.clipStrength ?? lora.strength } : {}) });
        if (index >= chain.length) {
          lastModel = target;
          if (target.type === 'LoraLoader' && lastClip) lastClip = target;
        }
      });
      if (loras.length > chain.length) {
        for (const c of downstreamModel) wf.connect(lastModel, 'MODEL', c.node, c.input);
        if (lastClip) for (const c of downstreamClip) wf.connect(lastClip, 'CLIP', c.node, c.input);
      }
      chain.slice(loras.length).forEach(n => n.bypass(true));
      notes.push(`LoRA 链：复用 ${reused} 个，新增 ${Math.max(0, loras.length - chain.length)} 个，旁路 ${Math.max(0, chain.length - loras.length)} 个`);
    },
    positive: sampler => conditioning(sampler, 'positive'),
    negative: sampler => conditioning(sampler, 'negative'),
    image(position = 'image') {
      const frame = report.media?.frames?.find(f => f.position === position);
      if (!frame) { warn(`解析结果没有作品${position === 'image' ? '图片' : position === 'first' ? '首帧' : '末帧'}`); return undefined; }
      return { __civitaiFillImage: frame.reference, position };
    },
    warn, note: text => notes.push(text),
  };

  return { wf, h, result: () => ({ ops, warnings, notes, missing }) };
}

/** Runs a rule module ({match?, default}) over a snapshot: {score, ops, warnings, notes, missing}. */
export async function runRule(module, snapshot, report) {
  if (typeof module.default !== 'function') throw new Error('规则缺少 export default function apply(report, wf, h)');
  const scoring = createRun(snapshot, report);
  const score = typeof module.match === 'function' ? Number(await module.match(scoring.wf, report)) || 0 : 0.1;
  const run = createRun(snapshot, report);
  await module.default(report, run.wf, run.h);
  return { score, ...run.result() };
}

export async function matchRule(module, snapshot, report) {
  if (typeof module.match !== 'function') return 0.1;
  return Number(await module.match(createRun(snapshot, report).wf, report)) || 0;
}
