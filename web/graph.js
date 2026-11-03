// The live ComfyUI graph for mapping rules: snapshots, rule runs in a worker, and applying a run's ops
// to the graph as one undoable change.
import { ruleSourceProblems } from './facade.js';

const MODEL_FOLDERS = ['checkpoints', 'loras', 'vae', 'diffusion_models', 'unet', 'text_encoders', 'clip', 'controlnet', 'upscale_models'];
let nodeDefs = null;

const graphNodes = graph => graph._nodes ?? graph.nodes ?? [];
const graphLinks = graph => (graph.links instanceof Map ? [...graph.links.values()] : Object.values(graph.links ?? {})).filter(Boolean);

function widgetInfo(widget) {
  const values = widget.options?.values;
  const base = { name: widget.name, value: widget.value };
  if (Array.isArray(values)) return { ...base, type: 'combo', values: [...values] };
  if (typeof widget.value === 'number') return { ...base, type: 'number', ...(widget.options?.min !== undefined ? { min: widget.options.min } : {}), ...(widget.options?.max !== undefined ? { max: widget.options.max } : {}) };
  if (typeof widget.value === 'boolean') return { ...base, type: 'toggle' };
  return { ...base, type: 'text', value: widget.value == null ? '' : String(widget.value) };
}

/** {nodes, links, defs, models} of the open workflow (root graph). */
export async function takeSnapshot(app, api) {
  const graph = app.graph;
  nodeDefs ??= Object.fromEntries(Object.entries(await api.getNodeDefs()).map(([type, def]) =>
    [type, { input: def.input, output: def.output, output_name: def.output_name, display_name: def.display_name }]));
  const available = new Set(await (await api.fetchApi('/models')).json().catch(() => []));
  const models = {};
  await Promise.all(MODEL_FOLDERS.filter(f => available.has(f)).map(async folder => {
    models[folder] = await (await api.fetchApi(`/models/${folder}`)).json().catch(() => []);
  }));
  return {
    nodes: graphNodes(graph).map(node => ({
      id: node.id, type: node.type, title: node.title, mode: node.mode ?? 0,
      inputs: (node.inputs ?? []).map(input => ({ name: input.name, type: String(input.type), link: input.link ?? null })),
      outputs: (node.outputs ?? []).map(output => ({ name: output.name, type: String(output.type), links: [...(output.links ?? [])] })),
      widgets: (node.widgets ?? []).filter(w => w.name && !String(w.type).startsWith('converted')).map(widgetInfo),
    })),
    links: graphLinks(graph).map(link => ({ id: link.id, from: link.origin_id, fromSlot: link.origin_slot, to: link.target_id, toSlot: link.target_slot, type: String(link.type) })),
    defs: nodeDefs, models,
  };
}

/** A snapshot small enough for a model or an MCP client: no node definitions, shortened lists. */
export function compactSnapshot(snapshot) {
  const linkFrom = new Map(snapshot.links.map(l => [l.id, `${l.from}:${l.fromSlot}`]));
  const short = value => typeof value === 'string' && value.length > 300 ? value.slice(0, 300) + '…' : value;
  return {
    nodes: snapshot.nodes.map(node => ({
      id: node.id, type: node.type, ...(node.title !== node.type ? { title: node.title } : {}), ...(node.mode ? { mode: node.mode } : {}),
      inputs: node.inputs.map(i => ({ name: i.name, type: i.type, from: i.link != null ? linkFrom.get(i.link) ?? null : null })),
      outputs: node.outputs.map(o => o.name),
      widgets: node.widgets.map(w => ({ name: w.name, value: short(w.value), ...(w.values ? { values: w.values.length > 25 ? [...w.values.slice(0, 25), `…共 ${w.values.length} 项`] : w.values } : {}) })),
    })),
    models: Object.fromEntries(Object.entries(snapshot.models).map(([folder, files]) => [folder, files.length > 300 ? [...files.slice(0, 300), `…共 ${files.length} 个`] : files])),
  };
}

/** Runs a rule's source in a fresh worker (5 s limit): {score, ops, warnings, notes, missing}. */
export function runInWorker(source, snapshot, report, mode = 'run') {
  const problems = ruleSourceProblems(source);
  if (problems.length) return Promise.reject(new Error(problems.join('；')));
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    const timer = setTimeout(() => { worker.terminate(); reject(new Error('规则运行超过 5 秒，已停止')); }, 5000);
    const finish = callback => value => { clearTimeout(timer); worker.terminate(); callback(value); };
    worker.onmessage = finish(({ data }) => data.error ? reject(new Error(data.error)) : resolve(data.result));
    worker.onerror = finish(event => reject(new Error(event.message || '规则加载失败（语法错误？）')));
    worker.postMessage({ source, snapshot, report, mode });
  });
}

// A spot for a new node near `near` that overlaps no existing node (title bar included).
function freeSpot(graph, near, size) {
  const TITLE = 30, GAP = 30;
  const boxes = graphNodes(graph).map(n => [n.pos[0], n.pos[1] - TITLE, n.size[0], n.size[1] + TITLE]);
  const free = ([x, y]) => !boxes.some(([bx, by, bw, bh]) => x < bx + bw + GAP && x + size[0] + GAP > bx && y - TITLE < by + bh + GAP && y + size[1] + GAP > by);
  if (!near) return [0, Math.max(0, ...boxes.map(([, by, , bh]) => by + bh)) + 80];
  const [x, y] = near.pos, [w, h] = near.size;
  const candidates = [[x + w + 2 * GAP, y], [x, y + h + TITLE + 2 * GAP], [x, y - size[1] - TITLE - 2 * GAP], [x - size[0] - 2 * GAP, y]];
  for (let step = 1; step <= 30; step++) candidates.push([x + w + 2 * GAP, y + step * (size[1] / 2 + GAP)], [x, y + h + TITLE + 2 * GAP + step * (size[1] / 2 + GAP)]);
  return candidates.find(free) ?? candidates[0];
}

/** Applies a run's ops to the live graph as one undoable change; returns problems met on the way. */
export async function applyOps(app, api, ops) {
  const graph = app.graph, created = new Map(), problems = [];
  const live = id => (typeof id === 'string' && id.startsWith('new:') ? created.get(id) : graph.getNodeById(id)) ?? null;
  const tracker = app.extensionManager?.workflow?.activeWorkflow?.changeTracker;
  // Work images are downloaded first, so the graph changes in one go.
  const images = new Map();
  for (const op of ops.filter(o => o.op === 'image')) {
    const response = await api.fetchApi('/civitai-fill/input-image', { method: 'POST', body: JSON.stringify({ reference: op.reference }) });
    const body = await response.json();
    if (!response.ok) problems.push(`作品图片下载失败：${body.error}`); else images.set(op.reference, body.name);
  }
  tracker?.beforeChange?.();
  try {
    for (const op of ops) {
      if (op.op === 'add') {
        const node = globalThis.LiteGraph.createNode(op.type);
        if (!node) { problems.push(`无法创建节点 ${op.type}`); continue; }
        if (op.title) node.title = op.title;
        node.pos = freeSpot(graph, live(op.near), node.size ?? [315, 130]);
        graph.add(node);
        created.set(op.ref, node);
      } else if (op.op === 'set' || op.op === 'image') {
        const node = live(op.node), widget = node?.widgets?.find(w => w.name === op.widget);
        const value = op.op === 'image' ? images.get(op.reference) : op.value;
        if (!widget) { problems.push(`节点 ${op.node} 没有控件 ${op.widget}`); continue; }
        if (value === undefined) continue;
        if (op.op === 'image' && Array.isArray(widget.options?.values) && !widget.options.values.includes(value)) widget.options.values.push(value);
        widget.value = value;
        widget.callback?.(value, app.canvas, node);
      } else if (op.op === 'connect') {
        const from = live(op.from), to = live(op.to);
        const slot = to?.findInputSlot?.(op.input) ?? -1;
        if (!from || !to || slot < 0) { problems.push(`无法连线 ${op.from} → ${op.to}.${op.input}`); continue; }
        from.connect(op.output, to, slot);
      } else if (op.op === 'mode') {
        const node = live(op.node);
        if (node) node.mode = op.mode;
      }
    }
  } finally {
    graph.setDirtyCanvas?.(true, true);
    tracker?.afterChange?.();
    tracker?.checkState?.();
  }
  return problems;
}
