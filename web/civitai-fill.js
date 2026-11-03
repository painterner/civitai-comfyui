// Civitai 填充 sidebar: parse a Civitai work through MaiHub, pick or generate a mapping rule, preview its
// changes to the open workflow and apply them. Also answers the backend's bridge requests, so agents
// (HTTP API / MCP) can read the workflow and dry-run or apply rules in this tab.
import { app } from '../../scripts/app.js';
import { api } from '../../scripts/api.js';
import { ruleHeader } from './facade.js';
import { takeSnapshot, compactSnapshot, runInWorker, applyOps } from './graph.js';

const STYLE = `
.cf{display:flex;flex-direction:column;gap:12px;padding:12px;font-size:13px;color:var(--fg-color,#ddd);overflow:auto;height:100%;box-sizing:border-box}
.cf h3{margin:0;font-size:14px}.cf section{display:flex;flex-direction:column;gap:6px;border:1px solid var(--border-color,#444);border-radius:8px;padding:10px}
.cf input,.cf select,.cf textarea{background:var(--comfy-input-bg,#222);color:inherit;border:1px solid var(--border-color,#444);border-radius:6px;padding:6px;font:inherit;width:100%;box-sizing:border-box}
.cf textarea{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px}
.cf .row{display:flex;gap:6px;flex-wrap:wrap}.cf .row>*{flex:1}
.cf button{background:var(--comfy-input-bg,#333);color:inherit;border:1px solid var(--border-color,#555);border-radius:6px;padding:6px 10px;cursor:pointer}
.cf button.primary{background:#2b6cb0;border-color:#2b6cb0;color:#fff}.cf button:disabled{opacity:.5;cursor:default}
.cf .muted{color:var(--descrip-text,#999);font-size:12px}.cf .warn{color:#f6ad55}.cf .error{color:#fc8181;white-space:pre-wrap}.cf .ok{color:#68d391}
.cf ul{margin:0;padding-left:18px}.cf li{margin:2px 0;word-break:break-word}.cf code{font-family:ui-monospace,monospace;font-size:12px}
.cf details summary{cursor:pointer}`;

const state = { report: null, rules: [], sources: new Map(), ruleId: '', result: null, aiSource: '', aiProblems: [], busy: false };
let root = null;
const $ = selector => root.querySelector(selector);
const escape = text => String(text ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

async function request(path, options = {}) {
  const response = await api.fetchApi(`/civitai-fill${path}`, { ...options, ...(options.body && typeof options.body !== 'string' ? { body: JSON.stringify(options.body) } : {}) });
  const body = response.headers.get('content-type')?.includes('json') ? await response.json() : await response.text();
  if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`);
  return body;
}
async function ruleSource(id) {
  if (!state.sources.has(id)) state.sources.set(id, (await request(`/rules/${encodeURIComponent(id)}`)).source);
  return state.sources.get(id);
}
function setStatus(selector, text, kind = 'muted') { const el = $(selector); el.className = kind; el.textContent = text; }
async function busy(label, task) {
  if (state.busy) return;
  state.busy = true; root.querySelectorAll('button').forEach(b => { b.disabled = true; });
  setStatus('#cf-status', label + '…');
  try { await task(); setStatus('#cf-status', ''); } catch (error) { setStatus('#cf-status', error.message, 'error'); }
  finally { state.busy = false; root.querySelectorAll('button').forEach(b => { b.disabled = false; }); }
}

// The run's ops as a readable change list.
function renderResult(result, { title = '修改预览' } = {}) {
  if (!root) return;  // an agent's run before the panel was opened
  const snapshotNodes = new Map((state.lastSnapshot?.nodes ?? []).map(n => [n.id, n]));
  const name = id => { const n = snapshotNodes.get(id); return n ? `${n.title || n.type}（${id}）` : `新节点 ${id}`; };
  const short = value => { const text = typeof value === 'string' ? value : JSON.stringify(value); return text.length > 80 ? text.slice(0, 80) + '…' : text; };
  const lines = result.ops.map(op => {
    if (op.op === 'set') return `${escape(name(op.node))}：<code>${escape(op.widget)}</code> ${escape(short(op.old))} → <b>${escape(short(op.value))}</b>`;
    if (op.op === 'add') return `新增 <b>${escape(op.title || op.type)}</b>（${escape(op.ref)}）`;
    if (op.op === 'connect') return `连线 ${escape(name(op.from))}.${escape(op.outputName)} → ${escape(name(op.to))}.${escape(op.input)}`;
    if (op.op === 'mode') return `${op.mode === 4 ? '旁路' : '恢复'} ${escape(name(op.node))}`;
    if (op.op === 'image') return `${escape(name(op.node))}：<code>${escape(op.widget)}</code> ← 作品图片`;
    return escape(JSON.stringify(op));
  });
  $('#cf-result').innerHTML = `<h3>${title}（${result.ops.length} 项）</h3>
    ${lines.length ? `<ul>${lines.map(l => `<li>${l}</li>`).join('')}</ul>` : '<p class="muted">没有需要修改的地方</p>'}
    ${result.missing.length ? `<p class="warn">本机缺少的模型（未替换）：</p><ul>${result.missing.map(m => `<li>${escape(m.folder)}：${escape(m.name ?? '')} ${escape(m.versionName ?? '')}${m.url ? ` · <a href="${escape(m.url.replace('/api/download/models/', '/model-versions/'))}" target="_blank" rel="noopener">Civitai</a>` : ''}</li>`).join('')}</ul>` : ''}
    ${result.warnings.length ? `<p class="warn">提醒：</p><ul>${result.warnings.map(w => `<li class="warn">${escape(w)}</li>`).join('')}</ul>` : ''}
    ${result.notes.length ? `<ul>${result.notes.map(n => `<li class="muted">${escape(n)}</li>`).join('')}</ul>` : ''}`;
}

function renderReport() {
  if (!root) return;
  const r = state.report;
  if (!r) { $('#cf-report').innerHTML = ''; return; }
  const stage = r.generation?.stages?.find(s => s.id === r.generation.selectedStage) ?? r.generation?.stages?.[0];
  const p = stage?.parameters ?? {};
  const frames = r.media?.frames ?? [];
  $('#cf-report').innerHTML = `<p>checkpoint：${escape(r.checkpoints?.map(c => `${c.name} ${c.versionName ?? ''}`).join('、') || '未公开')}</p>
    <p>LoRA ${r.loras?.length ?? 0} 个${r.loras?.length ? '：' + escape(r.loras.map(l => `${l.name}${l.strength == null ? '' : ' ×' + l.strength}`).join('、')) : ''}</p>
    <p class="muted">${escape([p.steps && `${p.steps} 步`, p.cfg != null && `CFG ${p.cfg}`, p.sampler, p.scheduler, p.width && `${p.width}×${p.height}`, p.seed != null && `种子 ${p.seed}`].filter(Boolean).join(' · '))}</p>
    ${p.prompt ? `<p class="muted">${escape(p.prompt.slice(0, 160))}${p.prompt.length > 160 ? '…' : ''}</p>` : ''}
    ${r.generation?.stages?.length > 1 ? `<p class="muted">共 ${r.generation.stages.length} 个生成阶段</p>` : ''}
    <p class="muted">${frames.length ? `作品图片：${frames.map(f => ({ image: '图片', first: '视频首帧', last: '视频末帧' })[f.position]).join('、')}` : '没有作品图片'}</p>
    ${r.warnings?.length ? `<details><summary class="warn">解析提醒 ${r.warnings.length} 条</summary><ul>${r.warnings.map(w => `<li>${escape(w)}</li>`).join('')}</ul></details>` : ''}`;
}

async function loadRules() {
  state.rules = await request('/rules');
  await rankRules();
}
// Rules sorted by how well they match the open workflow.
async function rankRules() {
  const snapshot = await takeSnapshot(app, api);
  state.lastSnapshot = snapshot;
  const scored = await Promise.all(state.rules.map(async rule => {
    try { return { ...rule, score: (await runInWorker(await ruleSource(rule.id), snapshot, state.report ?? {}, 'match')).score }; }
    catch { return { ...rule, score: -1 }; }
  }));
  state.rules = scored.sort((a, b) => b.score - a.score);
  const bound = app.graph.extra?.civitaiFill?.rule;
  state.ruleId = state.rules.find(r => r.id === bound)?.id ?? state.rules.find(r => r.score > 0)?.id ?? state.rules[0]?.id ?? '';
  $('#cf-rule').innerHTML = state.rules.map(rule => `<option value="${escape(rule.id)}" ${rule.id === state.ruleId ? 'selected' : ''}>${escape(rule.name)}${rule.builtin ? '（内置）' : ''}${rule.score > 0 ? ` · 匹配 ${Math.round(rule.score * 100)}%` : rule.score < 0 ? ' · 无法运行' : ''}</option>`).join('');
  $('#cf-rule-description').textContent = state.rules.find(r => r.id === state.ruleId)?.description ?? '';
}

async function dryRun(source) {
  if (!state.report) throw new Error('请先解析一个 Civitai 作品');
  const snapshot = await takeSnapshot(app, api);
  state.lastSnapshot = snapshot;
  state.result = await runInWorker(source, snapshot, state.report);
  renderResult(state.result);
  return state.result;
}

async function applyCurrent(source, ruleId) {
  const result = await dryRun(source);
  const problems = await applyOps(app, api, result.ops);
  if (ruleId) { app.graph.extra ??= {}; app.graph.extra.civitaiFill = { rule: ruleId, source: state.report?.sourceUrl }; }
  renderResult(result, { title: problems.length ? '已应用（部分失败）' : '已应用' });
  if (problems.length && root) $('#cf-result').insertAdjacentHTML('beforeend', `<ul>${problems.map(p => `<li class="error">${escape(p)}</li>`).join('')}</ul>`);
  app.extensionManager?.toast?.add?.({ severity: 'success', summary: 'Civitai 填充', detail: `已应用 ${result.ops.length} 项修改，可 Ctrl+Z 撤销`, life: 4000 });
  return { ...result, applied: true, problems };
}

// 「AI 生成规则」: a rule for the open workflow, dry-run before it is shown for saving.
async function generateRule(fix = false) {
  if (!state.report) throw new Error('请先解析一个 Civitai 作品，AI 需要它来确定要填的参数');
  const snapshot = await takeSnapshot(app, api);
  const body = { workflow: compactSnapshot(snapshot), report: compactReport(state.report), instruction: $('#cf-ai-instruction').value.trim(),
    ...(fix ? { previous: $('#cf-code').value, problems: state.aiProblems } : {}) };
  const { source, explanation } = await request('/ai/generate', { method: 'POST', body });
  $('#cf-code').value = source;
  $('#cf-editor').open = true;
  $('#cf-rule-id').value ||= slug(ruleHeader(source).name) || 'ai-rule';
  try {
    const result = await dryRun(source);
    state.aiProblems = result.warnings.filter(w => /没有控件|没有可选值|没有输入|没有输出|不能连到|没有节点类型/.test(w));
  } catch (error) { state.aiProblems = [error.message]; setStatus('#cf-ai-status', error.message, 'error'); }
  setStatus('#cf-ai-status', state.aiProblems.length ? `试运行有 ${state.aiProblems.length} 个问题，可点「让 AI 修正」` : (explanation || 'AI 规则已试运行，确认预览和代码后保存'), state.aiProblems.length ? 'warn' : 'ok');
}
const slug = text => String(text ?? '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64);
const compactReport = report => ({ checkpoints: report.checkpoints, loras: report.loras?.map(({ name, versionId, versionName, baseModel, strength, usages }) => ({ name, versionId, versionName, baseModel, strength, usages })),
  generation: report.generation, mediaType: report.mediaType, media: report.media && { type: report.media.type, frames: report.media.frames?.map(f => ({ position: f.position })) } });

async function loadSettings() {
  const s = await request('/settings');
  $('#cf-maihub-url').value = s.maihub_url; $('#cf-maihub-token').placeholder = s.maihub_token_set ? '已保存（留空不修改）' : 'mh_…';
  $('#cf-llm-url').value = s.llm_base_url; $('#cf-llm-model').value = s.llm_model;
  $('#cf-llm-key').placeholder = s.llm_api_key_set ? '已保存（留空不修改）' : 'sk-…';
  if (!s.maihub_token_set) $('#cf-settings').open = true;
}
async function saveSettings() {
  const changes = { maihub_url: $('#cf-maihub-url').value, llm_base_url: $('#cf-llm-url').value, llm_model: $('#cf-llm-model').value };
  if ($('#cf-maihub-token').value) changes.maihub_token = $('#cf-maihub-token').value;
  if ($('#cf-llm-key').value) changes.llm_api_key = $('#cf-llm-key').value;
  await request('/settings', { method: 'PUT', body: changes });
  $('#cf-maihub-token').value = ''; $('#cf-llm-key').value = '';
  await loadSettings();
  setStatus('#cf-status', '设置已保存', 'ok');
}

function mount(element) {
  if (!root) {
    root = document.createElement('div');
    root.className = 'cf';
    root.innerHTML = `<section><h3>Civitai 作品</h3>
        <input id="cf-url" placeholder="https://civitai.com/images/123456">
        <div class="row"><button id="cf-inspect" class="primary">解析</button></div>
        <div id="cf-report"></div></section>
      <section><h3>映射规则</h3>
        <select id="cf-rule"></select><p id="cf-rule-description" class="muted"></p>
        <div class="row"><button id="cf-preview">预览</button><button id="cf-apply" class="primary">应用到当前工作流</button></div>
        <details id="cf-ai"><summary>AI 生成规则</summary>
          <textarea id="cf-ai-instruction" rows="3" placeholder="可选：补充要求，例如「第二个 KSampler 是高清修复」"></textarea>
          <div class="row"><button id="cf-ai-generate">AI 生成规则</button><button id="cf-ai-fix">让 AI 修正</button></div>
          <p id="cf-ai-status" class="muted">按规则规范、当前工作流和解析结果生成，先试运行再保存。</p></details>
        <details id="cf-editor"><summary>规则代码</summary>
          <textarea id="cf-code" rows="14" spellcheck="false" placeholder="// @name 我的规则"></textarea>
          <div class="row"><input id="cf-rule-id" placeholder="规则 ID，如 my-flux"><button id="cf-code-load">载入所选规则</button></div>
          <div class="row"><button id="cf-code-run">试运行</button><button id="cf-code-apply">应用</button><button id="cf-code-save" class="primary">保存</button><button id="cf-code-delete">删除</button></div>
          <p class="muted">规范：<a href="/civitai-fill/spec" target="_blank">规则文档</a> · MCP：<code>${escape(location.origin)}/civitai-fill/mcp</code></p></details></section>
      <p id="cf-status" class="muted"></p>
      <section id="cf-result"><p class="muted">解析作品后，预览会列出将要修改的控件、新增的节点和缺少的模型。</p></section>
      <details id="cf-settings"><summary>设置</summary><section>
        <label>MaiHub 地址<input id="cf-maihub-url"></label>
        <label>MaiHub API Token<input id="cf-maihub-token" type="password" autocomplete="off"></label>
        <p class="muted">在 MaiHub 网页的「API Token」页创建；用于调用 Civitai 资源解析和下载作品图片。</p>
        <label>模型服务地址（OpenAI 兼容，如 https://api.openai.com/v1）<input id="cf-llm-url"></label>
        <label>模型 API Key<input id="cf-llm-key" type="password" autocomplete="off"></label>
        <label>模型名<input id="cf-llm-model" placeholder="gpt-4.1"></label>
        <button id="cf-save-settings">保存设置</button></section></details>`;
    $('#cf-inspect').onclick = () => busy('正在解析（MaiHub）', async () => {
      state.report = await request('/inspect', { method: 'POST', body: { url: $('#cf-url').value.trim() } });
      renderReport(); await rankRules();
    });
    $('#cf-rule').onchange = event => { state.ruleId = event.target.value; $('#cf-rule-description').textContent = state.rules.find(r => r.id === state.ruleId)?.description ?? ''; };
    $('#cf-preview').onclick = () => busy('试运行', async () => dryRun(await ruleSource(state.ruleId)));
    $('#cf-apply').onclick = () => busy('应用', async () => applyCurrent(await ruleSource(state.ruleId), state.ruleId));
    $('#cf-ai-generate').onclick = () => busy('AI 正在生成规则', () => generateRule(false));
    $('#cf-ai-fix').onclick = () => busy('AI 正在修正规则', () => generateRule(true));
    $('#cf-code-load').onclick = () => busy('载入', async () => { $('#cf-code').value = await ruleSource(state.ruleId); const rule = state.rules.find(r => r.id === state.ruleId); $('#cf-rule-id').value = rule?.builtin ? `${rule.id}-copy` : rule?.id ?? ''; });
    $('#cf-code-run').onclick = () => busy('试运行', () => dryRun($('#cf-code').value));
    $('#cf-code-apply').onclick = () => busy('应用', () => applyCurrent($('#cf-code').value, ''));
    $('#cf-code-save').onclick = () => busy('保存', async () => {
      const id = $('#cf-rule-id').value.trim();
      await request(`/rules/${encodeURIComponent(id)}`, { method: 'PUT', body: { source: $('#cf-code').value } });
      state.sources.set(id, $('#cf-code').value); await loadRules(); state.ruleId = id; $('#cf-rule').value = id;
      setStatus('#cf-ai-status', `已保存规则 ${id}`, 'ok');
    });
    $('#cf-code-delete').onclick = () => busy('删除', async () => {
      const id = $('#cf-rule-id').value.trim();
      if (!id || !confirm(`删除规则 ${id}？`)) return;
      await request(`/rules/${encodeURIComponent(id)}`, { method: 'DELETE' }); state.sources.delete(id); await loadRules();
    });
    $('#cf-save-settings').onclick = () => busy('保存设置', saveSettings);
    busy('载入规则', async () => { await loadSettings(); await loadRules(); });
  }
  element.replaceChildren(root);
}

// Agents (HTTP API / MCP) reach the open workflow through this tab.
async function answer({ id, action, args }) {
  let reply;
  try {
    if (action === 'snapshot') reply = { result: compactSnapshot(await takeSnapshot(app, api)) };
    else if (action === 'dry_run') {
      const snapshot = await takeSnapshot(app, api);
      reply = { result: await runInWorker(args.source, snapshot, args.report) };
    } else if (action === 'apply') {
      state.report = args.report;
      renderReport();
      reply = { result: await applyCurrent(args.source, '') };
    } else reply = { error: `未知操作 ${action}` };
  } catch (error) { reply = { error: error.message }; }
  await api.fetchApi(`/civitai-fill/bridge/${id}`, { method: 'POST', body: JSON.stringify(reply) });
}

app.registerExtension({
  name: 'CivitaiFill',
  async setup() {
    const style = document.createElement('style');
    style.textContent = STYLE; document.head.append(style);
    app.extensionManager?.registerSidebarTab?.({ id: 'civitai-fill', icon: 'pi pi-images', title: 'Civitai 填充', tooltip: 'Civitai 填充：用作品参数填充工作流', type: 'custom', render: mount });
    api.addEventListener('civitai-fill.request', event => { void answer(event.detail); });
  },
});
