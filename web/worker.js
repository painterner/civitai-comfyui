// Runs one mapping rule over a workflow snapshot, apart from the page (graph.js starts it per run).
// ComfyUI also loads every .js in this folder as an extension, so it does nothing outside a worker.
import { runRule, matchRule } from './facade.js';

if (typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope) {
  self.onmessage = async ({ data: { source, snapshot, report, mode } }) => {
    try {
      // Rules are self-contained (docs/RULES.md); take away the network before their code runs.
      for (const name of ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'importScripts']) {
        try { self[name] = undefined; } catch { /* read-only in some engines */ }
      }
      const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
      const rule = await import(url);
      URL.revokeObjectURL(url);
      const result = mode === 'match' ? { score: await matchRule(rule, snapshot, report) } : await runRule(rule, snapshot, report);
      self.postMessage({ result });
    } catch (error) {
      self.postMessage({ error: error?.stack ? `${error.message}\n${error.stack.split('\n').slice(1, 4).join('\n')}` : String(error) });
    }
  };
}
