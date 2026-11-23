// 端到端冒烟测试：node test-e2e.mjs [providerId] [modelId] [effort]
// 例: node test-e2e.mjs godagent claude-haiku-4-5-20251001
//     node test-e2e.mjs godagent:cc-cheap claude-opus-5 low
import { Config, apply } from './lib/index.js';

const PROVIDER = process.argv[2] ?? 'godagent';
const MODEL = process.argv[3] ?? 'claude-haiku-4-5-20251001';
const EFFORT = process.argv[4] ?? undefined;

// 用 real config 启用两个代表性分组：default(1×) + cc-cheap(0.4×)
const config = Config({ enabled: true, enabledGroups: ['default', 'cc-cheap', 'codex'] });
const releases = [];
const ctx = {
  fiber: { entry: { options: { id: 'dsh-connect-godagent' } } },
  logger: {
    info: (m) => console.log('[info]', m),
    warn: (m) => console.log('[warn]', m),
    debug: (m) => console.log('[debug]', m),
  },
  on: (_evt, fn) => releases.push(fn),
  llm: {
    registerAdapter: (providers, adapter) => {
      console.log('[registerAdapter]', providers.join(', '));
      globalThis.__adapter = adapter;
      return () => {};
    },
    registerConfigurableProviders: (list) => {
      for (const p of list) console.log('[provider]', p.provider, '→', p.displayName);
      return () => {};
    },
    registerModelDiscovery: (_ns, fn) => {
      globalThis.__discovery = fn;
      return () => {};
    },
  },
};

await apply(ctx, config);

// discovery 按 provider 查询
for (const p of ['godagent', 'godagent:cc-cheap', 'godagent:codex']) {
  const list = await globalThis.__discovery({ provider: p });
  console.log(`[discovery] ${p}: ${list.length} models, e.g. ${list.slice(0, 4).map((m) => m.id).join(', ')}`);
}

// 真实流式对话（走指定分组）
console.log(`\n[stream] provider=${PROVIDER} model=${MODEL} effort=${EFFORT ?? '<none>'}`);
const chunks = [];
for await (const chunk of globalThis.__adapter.stream({
  provider: PROVIDER,
  model: MODEL,
  ...(EFFORT ? { reasoningEffort: EFFORT } : {}),
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with exactly: PONG' }] }],
})) {
  chunks.push(chunk);
  if (chunk.type === 'text-delta') process.stdout.write(chunk.text ?? '');
  else if (chunk.type !== 'text-delta') console.log(`[chunk] ${chunk.type}`, JSON.stringify(chunk).slice(0, 140));
}
console.log('\n[OK] chunks:', chunks.length);
for (const fn of releases.splice(0)) await fn?.();
process.exit(0);
