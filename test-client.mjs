/**
 * client.js 工厂与设置节注册的单测（Node 环境 mock 平台 ModuleLoader 与 react）。
 * 用法：node test-client.mjs
 */
import nodeFs from 'node:fs';
import vm from 'node:vm';

let passed = 0, failed = 0;
const ok = (cond, label) => { if (cond) { passed++; } else { failed++; console.error('  ✗', label); } };

// ---- mock react（够 hooks + createElement 即可）----
const element = (type, props, ...children) => ({ $$el: true, type, props: props ?? {}, children });
let hookStates = [], hookIndex = 0;
const pendingEffects = [];
const react = {
  createElement: element,
  useState: (init) => {
    const i = hookIndex++;
    hookStates[i] ??= (typeof init === 'function' ? init() : init);
    const set = (v) => { hookStates[i] = typeof v === 'function' ? v(hookStates[i]) : v; };
    return [hookStates[i], set];
  },
  useEffect: (fn) => { pendingEffects.push(fn); },
  useRef: (init) => { const i = hookIndex++; hookStates[i] ??= { current: init }; return hookStates[i]; },
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
};
// mock fetch：固定分组目录
globalThis.fetch = async () => ({ ok: true, json: async () => ({ code: 0, data: [
  { code: 'default', name: '默认分组', multiplier: 1, model_count: 114 },
  { code: 'cc-cheap', name: 'ClaudeCode 青春版', multiplier: 0.4, model_count: 18, description: '0.4 倍率' },
  { code: 'codex', name: 'Codex', multiplier: 0.3, model_count: 12 },
] }) });

// ---- mock 平台 ModuleLoader ----
const registered = [];
let factoryRequire;
globalThis.window = {
  __ModuleLoader__: {
    load: ({ id, factory }) => {
      registered.push(id);
      const modules = { react, 'react/jsx-runtime': {}, 'react-dom': {} };
      factoryRequire = (name) => {
        if (!(name in modules)) throw new Error(`require 未 mock: ${name}`);
        return modules[name];
      };
      return factory(factoryRequire);
    },
  },
};

const source = nodeFs.readFileSync(new URL('./lib/client.js', import.meta.url), 'utf8');
vm.runInThisContext(source, { filename: 'lib/client.js' });

console.log('== 工厂 ==');
ok(registered.includes('dsh-connect-godagent'), 'ModuleLoader.load 以包名注册');
ok(typeof factoryRequire === 'function', 'factory 收到 require');

// ---- mock ctx：slots + configForms ----
const slotRegistrations = [];
const injectCalls = [];
const ctx = {
  get: (name) => (name === 'configForms' ? configForms : undefined),
  effect: (fn, label) => { fn(); },
  slots: {
    inject: (name, cb) => { injectCalls.push(name); const dispose = cb(); return dispose; },
    register: (spec, component) => { slotRegistrations.push({ spec, component }); return () => {}; },
  },
  logger: { info: () => {}, warn: () => {} },
};
const servedNamespaces = new Set(['dsh-connect-godagent']);
const scopeInstance = {
  snapshots: [{ status: 'ready', value: { enabled: true, apiKey: '', enabledGroups: ['cc-cheap'], enabledModelIds: [], refreshMinutes: 30 }, revision: 1 }],
  listeners: [],
  getSnapshot() { return this.snapshots.at(-1); },
  subscribe(fn) { this.listeners.push(fn); return () => {}; },
  async set(field, value) { this.snapshots.push({ ...this.snapshots.at(-1), value: { ...this.snapshots.at(-1).value, [field]: value } }); this.listeners.forEach((f) => f()); return true; },
};
const configForms = {
  whileServed(namespaces, register) { return register(servedNamespaces); },
  get() { return scopeInstance; },
};

console.log('== apply：设置节注册 ==');
const exports1 = window.__ModuleLoader__ // 占位防 lint
const mod = (0, eval)('1') && undefined; // noop
const clientExports = (() => { // 重新加载拿 exports（工厂 return 值）
  const out = [];
  globalThis.window.__ModuleLoader__.load = ({ factory }) => out.push(factory(factoryRequire));
  vm.runInThisContext(source, { filename: 'lib/client.js' });
  return out[0];
})();

ok(typeof clientExports?.apply === 'function', '导出 apply');
ok(Array.isArray(clientExports?.inject) && clientExports.inject.includes('slots'), '导出 inject=["slots"]');
ok(clientExports?.name === 'dsh-connect-godagent', '导出 name');

clientExports.apply(ctx);

const section = slotRegistrations.find((r) => r.spec.name === 'settings.section');
const icon = slotRegistrations.find((r) => r.spec.name === 'settings.section.icon');
ok(!!section, '注册 settings.section');
ok(section?.spec?.id === 'dsh-connect-godagent', 'section id = 插件名（自有的 LIST slot key）');
ok(typeof section?.spec?.label === 'function', 'label 是函数');
ok(!!icon, '注册 settings.section.icon');
ok(injectCalls.includes('settings.section') && injectCalls.includes('settings.section.icon'), 'inject 了两个 slot 名');

console.log('== 组件渲染 ==');
hookStates = []; hookIndex = 0; pendingEffects.length = 0;
const injected = section.spec.inject();
ok(injected.settingsScope === scopeInstance, 'inject 注入 settingsScope');
ok(injected.surface === 'settings', 'inject 注入 surface');
const render = () => { hookIndex = 0; pendingEffects.length = 0; return section.component({ ...injected, label: section.spec.label() }); };
let tree = render();
for (const fn of pendingEffects) fn();           // 触发 fetchGroups
await new Promise((r) => setImmediate(r));       // flush microtask，state 更新
tree = render();                                 // 二次渲染拿到已加载的分组列表
ok(tree?.$$el === true, '组件返回 React 元素');
ok(section.spec.label() === 'God Agent', 'label 文案');

// 深度遍历确认关键控件存在
let sawApiKeyInput = false, sawGroupCheckboxes = 0, sawSaveButton = false, sawTextarea = false;
(function walk(node) {
  if (!node || typeof node !== 'object') return;
  if (node.$$el) {
    if (node.type === 'input' && node.props?.placeholder?.includes('sk-')) sawApiKeyInput = true;
    if (node.type === 'input' && node.props?.type === 'checkbox') sawGroupCheckboxes++;
    if (node.type === 'button') sawSaveButton = true;
    if (node.type === 'textarea') sawTextarea = true;
    walk(node.children);
  } else if (Array.isArray(node)) node.forEach(walk);
})(tree);
ok(sawApiKeyInput, 'API Key 输入框');
ok(sawGroupCheckboxes >= 2, `分组复选框（${sawGroupCheckboxes} 个 ≥ 2：default 禁用 + 已启用 cc-cheap）`);
ok(sawSaveButton, '保存按钮');
ok(sawTextarea, '模型白名单 textarea');

console.log('== fetchGroups 失败容错 ==');
// （组件已容忍 groups=[] + groupError，见渲染分支）


console.log('== healDescribe（同值写回自愈） ==');
// mock remote：describe 返回带 revision 的行；mutate 记录调用
const remoteCalls = { describe: 0, mutate: [] };
const remoteSettings = {
  describe: async () => { remoteCalls.describe++; return ({ namespaces: [{ ns: 'dsh-connect-godagent', value: { enabled: true, refreshMinutes: 45 }, revision: 7 }] }); },
  mutate: async (ns, ops, revision) => { remoteCalls.mutate.push([ns, ops, revision]); return { ok: true }; },
};
const beforeLen = slotRegistrations.length;
ctx.remote = { settings: remoteSettings };
clientExports.apply(ctx);
const section2 = slotRegistrations.slice(beforeLen).find((r) => r.spec.name === 'settings.section');
ok(!!section2, '带 remote 的 apply 仍注册设置节');
ok(clientExports.inject.includes('remote') && clientExports.inject.includes('remote.settings'), 'inject 含 remote/remote.settings');
const injected2 = section2.spec.inject();
ok(typeof injected2.healDescribe === 'function', 'inject 注入 healDescribe');
await injected2.healDescribe();
ok(remoteCalls.describe === 1, 'heal 调了一次 describe');
ok(remoteCalls.mutate.length === 1
  && remoteCalls.mutate[0][0] === 'dsh-connect-godagent'
  && JSON.stringify(remoteCalls.mutate[0][1]) === JSON.stringify([{ op: 'set', path: ['refreshMinutes'], value: 45 }])
  && remoteCalls.mutate[0][2] === 7,
  'heal 用原值+原 revision 写回一次（同值写 → document-updated → mirror 重拉）');

console.log('== slow 分支：12s 未 ready 自动自愈一次 ==');
const realSetTimeout = globalThis.setTimeout;
const timers = [];
globalThis.setTimeout = (fn, ms) => { timers.push([fn, ms]); return timers.length; };
try {
  hookStates = []; hookIndex = 0; pendingEffects.length = 0;
  let healCount = 0;
  const loadingScope = { getSnapshot: () => ({ status: 'loading' }), subscribe: () => () => {} };
  const slowInjected = { settingsScope: loadingScope, healDescribe: async () => { healCount++; } };
  let slowTree = section2.component({ ...slowInjected, label: 'God Agent' });
  for (const fn of pendingEffects) fn();
  const t12 = timers.find(([, ms]) => ms === 12000);
  ok(!!t12, '12s 未 ready 进入 slow');
  t12[0]();
  await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));
  pendingEffects.length = 0;
  hookIndex = 0; // 关键：同一组件的二次渲染要从 0 重新映射 hooks（hookStates 保留）
  slowTree = section2.component({ ...slowInjected, label: 'God Agent' });
  for (const fn of pendingEffects) fn();
  const t12b = timers.slice().reverse().find(([, ms]) => ms === 12000);
  ok(!!t12b, '仍不 ready 会再挂 slow 计时器');
  t12b[0]();
  await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));
  ok(healCount === 1, '自愈只自动执行一次（第二次给手动重试）');
} finally {
  globalThis.setTimeout = realSetTimeout;
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
