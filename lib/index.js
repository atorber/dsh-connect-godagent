/**
 * dsh-connect-godagent
 *
 * 把本机登录的 God Agent 桌面 App（gptgod.online）模型接入 DSH。
 *
 * 认证链（全部实测验证过）：
 *   1) 会话 cookie：God Agent 把 EGG_SESS + EGG_SESS.sig 存在
 *      ~/Library/Caches/com.xiangsx.godagent/.cookies（滚动 ~30 天）；
 *   2) cookie 失效时回退 Keychain refresh_token：
 *      `security find-generic-password -s com.xiangsx.godagent -w`
 *      → POST /api/user/app-refresh-login {refresh_token}
 *      → 响应里的 refresh_token 是单次轮换的，必须立刻写回 Keychain；
 *   3) API Key：gptgod 的 sk- key 全文只在创建时可见（list 只给 secret_hint），
 *      所以首次自动创建一枚 title="DSH GodAgent" 的 key 并存进本地 state 文件。
 *
 * 模型目录：GET https://api.gptgod.online/v1/models（Bearer sk-…），
 * 能力元数据（vision / reasoning / max_output_tokens）取自 God Agent 本地
 * cap-cache.json（App 自己维护），失败时给出保守缺省。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai';
import { resolveRetryPolicy } from '@deepseek-ai/dsh-llm';
import { createProvider } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import z from '@deepseek-ai/schemastery';

const execFileP = promisify(execFile);

const PLUGIN_ID = 'dsh-connect-godagent';
const PROVIDER = 'godagent';
const DISPLAY_NAME = 'God Agent (gptgod)';

const API_BASE = 'https://gptgod.online/api';
const OPENAI_BASE = 'https://api.gptgod.online/v1';
const SITE_BASE = 'https://gptgod.online';

const GA_CACHE_DIR = path.join(homedir(), 'Library', 'Caches', 'com.xiangsx.godagent');
const GA_COOKIES_FILE = path.join(GA_CACHE_DIR, '.cookies');
const GA_DATA_DIR = path.join(homedir(), 'Library', 'Application Support', 'com.xiangsx.godagent');
const GA_CAP_CACHE = path.join(GA_DATA_DIR, 'cap-cache.json');

const KEYCHAIN_SERVICE = 'com.xiangsx.godagent';
const KEYCHAIN_ACCOUNT = 'auth.refresh_token';

const STATE_DIR = path.join(homedir(), '.dsh', 'godagent-connect');
const STATE_FILE = path.join(STATE_DIR, 'state.json');

const API_KEY_TITLE = 'DSH GodAgent';

/** /user/api/create 的响应结构里全文密钥的候选字段名（未逐字确认，逐个尝试）。 */
const SECRET_KEYS = ['secret', 'key', 'api_key', 'apiKey', 'secret_full'];

//#region 状态持久化

async function loadState() {
  try {
    return JSON.parse(await readFile(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

async function saveState(state) {
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
  await chmod(STATE_FILE, 0o600).catch(() => {});
}

//#endregion
//#region God Agent 本机凭据读取

/** God Agent 的会话 cookie 文件 → "EGG_SESS=…; EGG_SESS.sig=…"。 */
async function readAppCookieHeader() {
  try {
    const rows = JSON.parse(await readFile(GA_COOKIES_FILE, 'utf8'));
    const pairs = rows
      .map((row) => String(row.raw_cookie ?? '').split(';')[0])
      .filter(Boolean);
    return pairs.length ? pairs.join('; ') : undefined;
  } catch {
    return undefined;
  }
}

async function keychainReadToken() {
  try {
    const { stdout } = await execFileP('security', [
      'find-generic-password', '-s', KEYCHAIN_SERVICE, '-w',
    ], { timeout: 5000 });
    const parsed = JSON.parse(stdout.trim());
    return { token: parsed.token, email: parsed.email };
  } catch {
    return {};
  }
}

async function keychainWriteToken(token, email) {
  const payload = JSON.stringify({ email: email ?? '', token });
  // promisify(execFile) 以非零退出码拒绝——拒绝即失败，无需检查 returnCode
  await execFileP('security', [
    'add-generic-password', '-s', KEYCHAIN_SERVICE,
    '-a', KEYCHAIN_ACCOUNT, '-U', '-w', payload,
  ], { timeout: 5000 });
}

//#endregion
//#region gptgod API 客户端

async function gptgodPost(pathname, body, cookieHeader) {
  const res = await fetch(API_BASE + pathname, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
      'User-Agent': 'GodAgent/1.4.11 (Macintosh; Intel Mac OS X)',
    },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`gptgod ${pathname} -> HTTP ${res.status}`);
  return res.json();
}

function collectSetCookies(res) {
  // Node fetch: res.headers.getSetCookie() 数组；每条形如 "EGG_SESS=…; Path=/; …"
  return (res.headers.getSetCookie?.() ?? [])
    .map((line) => line.split(';')[0])
    .filter(Boolean);
}

/**
 * 确保"可用会话"：依次尝试 state cookies → App cookie 文件 → Keychain 刷新。
 * 返回 { cookieHeader, email }；全部失败则抛错。
 */
export async function ensureSession(state) {
  const candidates = [];
  if (state.cookies?.length) candidates.push(state.cookies.join('; '));
  const appCookie = await readAppCookieHeader();
  if (appCookie) candidates.push(appCookie);

  for (const cookieHeader of candidates) {
    try {
      const reply = await gptgodPost('/user/info', {}, cookieHeader);
      if (reply?.code === 0) {
        state.cookies = cookieHeader.split('; ');
        return { cookieHeader, email: reply.data?.email };
      }
    } catch {} // 网络失败换下一个凭据源
  }

  // cookie 全部失效 → Keychain refresh_token 换新会话
  const { token, email } = await keychainReadToken();
  if (!token) throw new Error('God Agent 凭据全部不可用：请先在 God Agent App 里登录');

  const res = await fetch(API_BASE + '/user/app-refresh-login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'GodAgent/1.4.11 (Macintosh; Intel Mac OS X)' },
    body: JSON.stringify({ refresh_token: token }),
    signal: AbortSignal.timeout(20000),
  });
  const reply = await res.json().catch(() => ({}));
  if (reply?.code !== 0 || !reply.data?.refresh_token) {
    throw new Error(`God Agent 刷新登录失败：${reply?.msg ?? `HTTP ${res.status}`}`);
  }

  // 单次轮换：必须立刻写回，否则 App 下次冷启动要求重新登录
  await keychainWriteToken(reply.data.refresh_token, email);

  const fresh = collectSetCookies(res);
  if (fresh.length) {
    state.cookies = fresh;
    await saveState(state);
    return { cookieHeader: fresh.join('; '), email };
  }
  // 上游没下发新 cookie 时退回旧候选再探测一次
  return ensureSession({ ...state, cookies: [] });
}

/** 拿到可用的 sk- key：config 显式 > state 已存 > 同名旧 key 清理后新建一枚。 */
export async function ensureApiKey(state, cookieHeader, config, groupCode = 'default') {
  const explicit = liveValue(config.apiKey)?.trim?.();
  if (explicit && groupCode === 'default') return explicit;

  state.apiKeys = state.apiKeys ?? {};
  if (state.apiKeys[groupCode]?.key) return state.apiKeys[groupCode].key;

  // 旧版单 key state 迁移：default 分组直接继承
  if (groupCode === 'default' && state.apiKey) return state.apiKey;

  const title = groupCode === 'default' ? API_KEY_TITLE : `${API_KEY_TITLE} · ${groupCode}`;
  // 全文密钥只在创建响应里出现（list 只给 secret_hint）：state 丢失后旧 key 无法复用，删除重建避免堆积
  const listReply = await gptgodPost('/user/api/list', {}, cookieHeader).catch(() => undefined);
  const rows = listReply?.code === 0 ? (listReply.data?.rows ?? listReply.data ?? []) : [];
  const stale = Array.isArray(rows)
    ? rows.find((row) => row?.title === title && (!row.group_code || row.group_code === groupCode))
    : undefined;
  if (stale?.id != null) {
    await gptgodPost('/user/api/delete', { id: stale.id }, cookieHeader).catch(() => {});
  }

  const reply = await gptgodPost('/user/api/create', {
    title,
    group_code: groupCode,
  }, cookieHeader);
  if (reply?.code !== 0) {
    throw new Error(`创建 gptgod API Key（分组 ${groupCode}）失败：${reply?.msg ?? 'unknown'}`);
  }
  const data = reply.data ?? {};
  const secret = SECRET_KEYS.map((k) => data[k]).find((v) => typeof v === 'string' && v.startsWith('sk-'));
  if (!secret) {
    throw new Error(`创建成功但未识别密钥字段（keys: ${Object.keys(data).join(',')}）`);
  }
  state.apiKeys[groupCode] = { key: secret, id: data.id };
  if (groupCode === 'default') { state.apiKey = secret; state.apiKeyId = data.id; } // 兼容旧读取方
  await saveState(state);
  return secret;
}

/**
 * 拉取 gptgod 分组目录（公开接口，无需认证）：
 * [{code, name, description, multiplier, models: ['*']|[id...], is_default}]
 * 结果缓存 6 小时（分组上下线频率低）。
 */
export async function loadGroups(state) {
  const CACHE_TTL = 6 * 3600_000;
  const cached = state.groupsCache;
  if (cached?.groups?.length && Date.now() - cached.at < CACHE_TTL) return cached.groups;
  const res = await fetch(`${SITE_BASE}/api/god-agent/groups`, {
    method: 'GET',
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`GET /api/god-agent/groups -> HTTP ${res.status}`);
  const body = await res.json();
  if (body?.code !== 0 || !Array.isArray(body.data)) {
    throw new Error(`分组目录响应异常: code=${body?.code}`);
  }
  const groups = body.data.filter((g) => g?.code);
  state.groupsCache = { at: Date.now(), groups };
  await saveState(state);
  return groups;
}

//#endregion
//#region 模型目录

/** 明显不是聊天模型的 id 片段（图像/语音/视频/向量化/审核/批量类）。 */
const NON_CHAT_RE = /(embed|whisper|tts|suno|dall[-.]?e|flux|midjourney|^mj|stable[- ]?diffusion|^sd[0-9x]|sora|veo|kling|runway|pika|luma|pixverse|hailuo|vidu|seedance|seedream|cogvideo|wan[-.]?x?|hidream|recraft|ideogram|gpt-image|image|video|music|audio|voice|asr|ocr|rerank|moderation|guard|clip|caption|transcribe|realtime|bge-|jina-clip|batch|gpts)/i;

/** openai-completions 的推理档位 → wire 值。 */
const OPENAI_REASONING_EFFORTS = { low: 'low', medium: 'medium', high: 'high' };
const THINKING_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
/** 订阅额度无单价可查，一律报 0（workbuddy 同款约定）。 */
const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 8_192;

/** 无探测数据时按 id 猜 reasoning：claude/gpt-5+/o系列/thinking 后缀等惯例。 */
const REASONING_HINT_RE = /(thinking|reasoning|^o[1-9]|gpt-[5-9]|claude-(opus|sonnet|haiku|fable)|gemini-[23]|deepseek-r|qwen3|kimi-[st]|glm-4\.[5-9]|minimax-m)/i;

/**
 * 模型费率 → 展示后缀 + pi-ai cost。
 * gptgod 计价四种：official（官方美元价/百万token）、times（积分/次）、
 * token（积分/百万token）、characters（按字符）。
 * 接口返回的分组 multiplier 直接乘进费率，展示与 cost 均为该分组实际费率
 * （倍率也显示在 provider 名称上）；展示折进模型 name（模型选择器的行
 * 文案就是 name），official 的 cost 同时供宿主成本统计使用。
 */
function priceInfo(id, group) {
  const p = group?.pricing?.[id];
  if (!p) return {};
  const mult = Number(group.multiplier) || 1;
  const fmt = (n) => (Number.isFinite(n) ? String(Math.round(n * 100) / 100) : '?');
  if (p.billing_type === 'official') {
    const input = Number(p.input_price) * mult, output = Number(p.output_price) * mult;
    return {
      suffix: ` · $${fmt(input)}/$${fmt(output)}`,
      ...(Number.isFinite(input) && Number.isFinite(output)
        ? { cost: { input, output, cacheRead: 0, cacheWrite: 0 } }
        : {}),
    };
  }
  if (p.billing_type === 'times') {
    const unit = p.price_unit === 'second' ? '分/秒' : '分/次';
    return { suffix: ` · ${fmt(Number(p.input_price) * mult)}${unit}` };
  }
  if (p.billing_type === 'token') {
    return { suffix: ` · ${fmt(Number(p.input_price) * mult)}/${fmt(Number(p.output_price) * mult)}分/M` };
  }
  if (p.billing_type === 'characters') return { suffix: ' · 按字符' };
  return {};
}

/** 单个模型 → pi-ai Model 描述符（workbuddy toPiModel 同款形状）。 */
function toPiModel(id, cap, providerId = PROVIDER, group) {
  // cap.reasoning 缺省（分组专属模型未被 App 探测过）时按 id 惯例推断
  const reasoning = typeof cap.reasoning === 'boolean' ? cap.reasoning : REASONING_HINT_RE.test(id);
  const thinkingLevelMap = reasoning
    ? Object.fromEntries(THINKING_LEVELS.map((level) => [level, level in OPENAI_REASONING_EFFORTS ? level : null]))
    : undefined;
  const { suffix, cost } = priceInfo(id, group);
  return {
    id,
    name: `${id}${suffix}`,
    api: 'openai-completions',
    provider: providerId,
    baseUrl: OPENAI_BASE,
    input: cap.vision ? ['text', 'image'] : ['text'],
    ...(cost ? { cost } : { cost: NO_COST }),
    contextWindow: cap.contextWindow || DEFAULT_CONTEXT_WINDOW,
    maxTokens: cap.maxOutputTokens || DEFAULT_MAX_TOKENS,
    reasoning,
    ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
    compat: { supportsReasoningEffort: reasoning },
  };
}

/**
 * 解析 God Agent 本地 cap-cache.json。
 * 结构：{ doc: { groups: { <group>: { caps: { <modelId>: {
 *   by_format: { openai: {…}, claude: {…} }, formats: 'openai,claude',
 *   context_window, max_output_tokens, reasoning, vision, … } } } } } }
 * App 对每个模型×格式做过真实探测（by_format.openai.status），
 * 只有 openai 格式探测通过的模型才走 openai-completions 路由。
 */
async function loadCapIndex() {
  try {
    const raw = JSON.parse(await readFile(GA_CAP_CACHE, 'utf8'));
    const index = new Map();
    for (const group of Object.values(raw?.doc?.groups ?? {})) {
      for (const [modelId, cap] of Object.entries(group?.caps ?? {})) {
        const openai = cap?.by_format?.openai ?? {};
        const prev = index.get(modelId);
        const entry = {
          contextWindow: cap.context_window || prev?.contextWindow,
          maxOutputTokens: cap.max_output_tokens || openai.max_output_tokens || prev?.maxOutputTokens,
          reasoning: openai.reasoning ?? prev?.reasoning,
          vision: openai.vision ?? prev?.vision,
          formats: String(cap.formats ?? prev?.formats ?? ''),
          openaiStatus: openai.status ?? prev?.openaiStatus,
        };
        // 同一模型在多个分组出现：任一分组 openai 探测 ok 即视为可用
        if (prev?.openaiStatus === 'ok' && entry.openaiStatus !== 'ok') {
          entry.openaiStatus = 'ok';
        }
        index.set(modelId, entry);
      }
    }
    return index;
  } catch {
    return new Map();
  }
}

/** 该模型的 openai 格式可用（无探测数据时保守放行）。 */
function openaiFormatUsable(cap) {
  if (!cap || Object.keys(cap).length === 0) return true;
  if (cap.formats && !cap.formats.includes('openai')) return false;
  if (cap.openaiStatus === 'error' || cap.openaiStatus === 'failed') return false;
  return true;
}

/** 把模型清单 + cap-cache 能力 + 用户选择，折成 pi-ai 模型档案。 */
function buildModelProfiles(rawIds, caps, config, group, providerId) {
  const wanted = (liveValue(config.enabledModelIds) ?? []).filter(Boolean);
  // 分组模型清单：'*' 表示账户级 /v1/models 全量；否则分组清单即权威（/v1/models 只反映 default 组）
  const scope = Array.isArray(group?.models) && !group.models.includes('*') ? new Set(group.models) : null;
  const profiles = [];
  for (const id of scope ? [...scope] : rawIds) {
    if (!id || typeof id !== 'string') continue;
    if (NON_CHAT_RE.test(id)) continue;
    if (wanted.length && !wanted.includes(id)) continue;
    const cap = caps.get(id) ?? {};
    // 探测数据来自 App（default key 探测），对分组专属模型不可靠：
    // 仅在账户级目录（'*'）时用探测过滤；用户显式点名时以用户为准
    if (!scope && !openaiFormatUsable(cap) && !(wanted.length && wanted.includes(id))) continue;
    profiles.push(toPiModel(id, cap, providerId, group));
  }
  profiles.sort((a, b) => a.id.localeCompare(b.id));
  return profiles;
}

async function fetchModelIds(apiKey) {
  const res = await fetch(`${OPENAI_BASE}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`GET /v1/models -> HTTP ${res.status}`);
  const body = await res.json();
  const rows = body?.data ?? body?.models ?? [];
  return rows.map((row) => row?.id).filter(Boolean);
}

//#endregion
//#region pi-ai 认证桩（本路由没有 pi-ai 自己的凭据生命周期）

const INERT_AUTH = {
  credentials: {
    async read() { return undefined; },
    async list() { return []; },
    async modify() {
      throw new Error('dsh-connect-godagent: 本路由没有 pi-ai 凭据生命周期');
    },
    async delete() {
      throw new Error('dsh-connect-godagent: 本路由没有 pi-ai 凭据生命周期');
    },
  },
  async authContextEnv() { return undefined; },
  authContext: {
    async env() { return undefined; },
    async fileExists() { return false; },
  },
};

//#endregion
//#region 插件配置

/**
 * DSH 设置页只展示 volatile 字段：dsh-settings 的 volatileForm(schema) 会丢弃一切
 * 未标 meta.volatile 的标量字段（嵌套 object 除外），全标量 Config 的 namespace 会
 * 从 settings.describe() 整个消失，浏览器端表现为"等待宿主配置就绪…"。
 * WorkBuddy 的同款做法：每个设置页字段都包 asVolatile()。
 * 代价（已知并已处理）：volatile-only 的配置变更不会重载插件（cordis-plugin-loader
 * 的 volatileOnly 判断），apply 不重跑——宿主侧由 startConfigWatch() 每 60s 比对
 * 配置指纹，变化即重建模型目录并重新注册，弥补无重载的影响。
 */
/** schemastery .volatile() 包装：字段标 meta.volatile 后才会出现在 DSH 设置页（见 Config 注释）。 */
function volatile(schema) {
  if (typeof schema.volatile === 'function') return schema.volatile();
  return schema;
}

/** volatile 字段 resolve 后是 {get()} live reference，读取处统一解引用；普通值原样返回。 */
export function liveValue(value) {
  return value !== null && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value;
}

export const Config = z.object({
  enabled: volatile(z.boolean().default(true)).description('启用 God Agent (gptgod) 模型接入'),
  apiKey: volatile(z.string().default('').role('secret'))
    .description('gptgod API Key（sk-…），仅用于 default 分组；其余分组自动创建专用 key。留空全部自动'),
  enabledGroups: volatile(z.array(z.string()).default([]))
    .description('启用的分组 code，每个分组一个独立模型清单与计费倍率（留空 = 仅 default）。如 cc-cheap(0.4×)、codex(0.3×)、aws-vip(5×)'),
  enabledModelIds: volatile(z.array(z.string()).default([]))
    .description('只启用这些模型 id（留空 = 自动接入全部聊天模型，跨所有启用分组生效）'),
  refreshMinutes: volatile(z.number().step(1).min(5).default(30))
    .description('模型目录刷新周期（分钟）'),
}).description('God Agent (gptgod) 接入设置');

/** cordis 服务依赖：llm 服务由 @deepseek-ai/dsh-llm 提供，未声明会报 "cannot get property llm without inject"。 */
export const inject = ['llm'];
export const name = PLUGIN_ID;

//#endregion
//#region 入口

export async function apply(ctx, config) {
  // 注意：volatile 字段运行时可变且不触发插件重载，不能在 apply 里读一次就定终身。
  // enabled 的启停由下方 syncCatalog/巡检动态处理（false = 注销全部 provider）。

  const settingsNs = ctx.fiber?.entry?.options?.id ?? PLUGIN_ID;
  const state = await loadState();

  /** 每个 provider 一条：{providerId, group, models(pi-ai), discovery[]}；目录刷新时整体替换。 */
  let currentEntries = [];
  /** PiAiAdapter 快照：providerId → resolved profile（含各组分组的 piProvider）。 */
  let currentProfiles = new Map();

  const providerIdOf = (code) => (code === 'default' ? PROVIDER : `${PROVIDER}:${code}`);
  const displayNameOf = (group) => {
    const base = `${DISPLAY_NAME} · ${group.name || group.code}`;
    const mult = Number(group.multiplier ?? 1);
    return Number.isFinite(mult) && mult !== 1 ? `${base} (${mult}×)` : base;
  };

  /** 由分组清单重建全部 provider（每个分组一个 pi-ai Provider + 独立 API key）。 */
  const rebuildProfiles = (entries) => {
    currentEntries = entries;
    currentProfiles = new Map();
    for (const entry of entries) {
      const piProvider = createProvider({
        id: entry.providerId,
        name: entry.displayName,
        baseUrl: OPENAI_BASE,
        auth: {
          apiKey: {
            name: 'gptgod API Key',
            async resolve() {
              const key = entry.apiKey ?? liveValue(config.apiKey) ?? undefined;
              if (!key) return undefined;
              return { auth: { apiKey: key }, source: PLUGIN_ID };
            },
          },
        },
        models: entry.profiles,
        api: openAICompletionsApi(),
      });
      currentProfiles.set(entry.providerId, {
        provider: entry.providerId,
        displayName: entry.displayName,
        piProvider,
        streamIdleTimeoutMs: 300_000,
        retryPolicy: resolveRetryPolicy(undefined, `${PLUGIN_ID} retryPolicy`),
        configuredMaxTokens: new Map(),
        modelErrors: new Map(),
      });
    }
  };

  const discoveryOf = (providerId) =>
    currentEntries.find((e) => e.providerId === providerId)?.discovery ?? [];

  /** 拉一次目录并落到 profiles；会话/密钥失败时保留旧目录并抛错。 */
  const refreshCatalog = async () => {
    const { cookieHeader } = await ensureSession(state);

    // 分组清单（公开接口）：config.enabledGroups 为空时仅 default
    const allGroups = await loadGroups(state);
    const wantedCodes = ((liveValue(config.enabledGroups) ?? []).length ? liveValue(config.enabledGroups) : ['default'])
      .map((c) => String(c).trim()).filter(Boolean);
    const knownCodes = new Set(allGroups.map((g) => g.code));
    const unknown = wantedCodes.filter((c) => !knownCodes.has(c));
    if (unknown.length) {
      ctx.logger?.warn?.(`[${PLUGIN_ID}] 未知分组已忽略: ${unknown.join(', ')}（可用: ${[...knownCodes].slice(0, 8).join(', ')}…）`);
    }
    const enabledCodes = wantedCodes.filter((c) => knownCodes.has(c));
    if (!enabledCodes.includes('default')) enabledCodes.unshift('default'); // default 永远保留

    // /v1/models 是账户级目录：default 组 key 拉一次即可
    const modelIdsKey = await ensureApiKey(state, cookieHeader, config, 'default');
    const [ids, caps] = [await fetchModelIds(modelIdsKey), await loadCapIndex()];

    const entries = [];
    for (const group of enabledCodes.map((code) => allGroups.find((g) => g.code === code))) {
      const apiKey = await ensureApiKey(state, cookieHeader, config, group.code);
      const profiles = buildModelProfiles(ids, caps, config, group, providerIdOf(group.code));
      entries.push({
        providerId: providerIdOf(group.code),
        group,
        apiKey,
        profiles,
        discovery: profiles.map((m) => ({
          id: m.id,
          name: m.name,
          ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
          ...(m.maxTokens ? { maxTokens: m.maxTokens } : {}),
          ...(m.input ? { inputModalities: m.input } : {}),
        })),
        displayName: displayNameOf(group),
      });
    }
    // 按倍率升序注册：模型选择器按目录顺序排列 provider，搜索同名模型时
    // 首个命中（回车直选的行）落在最便宜的分组上，避免总是命中 default(1×)
    entries.sort((a, b) =>
      Number(a.group.multiplier ?? 1) - Number(b.group.multiplier ?? 1)
      || (a.group.code === 'default' ? -1 : b.group.code === 'default' ? 1 : a.group.code.localeCompare(b.group.code)));
    rebuildProfiles(entries);
    await saveState(state);
    return entries;
  };

  const adapter = new PiAiAdapter({
    profiles: () => currentProfiles,
    resolveApiKey: async (provider) => {
      const entry = currentEntries.find((e) => e.providerId === provider);
      return entry?.apiKey ?? state.apiKey ?? liveValue(config.apiKey) ?? undefined;
    },
    auth: INERT_AUTH,
  });

  /** 当前注册句柄；重注册前先全部释放，避免 "already registered"。 */
  let releases = [];
  const releaseAll = () => {
    releases.splice(0).forEach((release) => {
      try { release(); } catch {}
    });
  };

  /** 把目录挂上 llm 服务；disabled=true 时全部注销（设置页开关关闭态）。 */
  const registerAll = (disabled = false) => {
    releaseAll();
    if (disabled) return;
    // currentProfiles.keys() 已含 default 组的 'godagent'；Set 去重避免 "already registered"
    releases.push(ctx.llm.registerAdapter([...new Set([PROVIDER, ...currentProfiles.keys()])], adapter));
    releases.push(ctx.llm.registerConfigurableProviders(currentEntries.length
      ? currentEntries.map((entry) => ({
          provider: entry.providerId,
          displayName: entry.displayName,
          settingsNs,
          settingsPath: [],
          declared: false,
        }))
      : [{
          provider: PROVIDER,
          displayName: DISPLAY_NAME,
          settingsNs,
          settingsPath: [],
          declared: false,
        }]));
    releases.push(ctx.llm.registerModelDiscovery(settingsNs, async (request, signal) => {
      if (!currentEntries.length) {
        try { await refreshCatalog(); } catch {} // 兜底重试，失败则交空
      }
      signal?.throwIfAborted?.();
      const provider = request?.provider;
      if (provider) return discoveryOf(provider);
      // 未指明 provider：返回 default 组的目录
      return discoveryOf(PROVIDER);
    }));
  };

  /** 同步目录：enabled=false 时注销全部 provider，否则拉目录并挂载。 */
  const syncCatalog = async () => {
    if (liveValue(config.enabled) === false) {
      rebuildProfiles([]);
      registerAll(true);
      ctx.logger?.info?.(`[${PLUGIN_ID}] 已停用（设置页可重新开启）`);
      return [];
    }
    const entries = await refreshCatalog();
    registerAll(false);
    return entries;
  };

  // 启动即同步；失败不阻塞挂载（保留空目录，discovery 兜底再试）。
  let firstError;
  try {
    await syncCatalog();
  } catch (error) {
    firstError = error;
    rebuildProfiles([]);
    registerAll(false);
    ctx.logger?.warn?.(`[${PLUGIN_ID}] 启动目录拉取失败（稍后自动重试）: ${error.message}`);
  }

  // 周期刷新目录（模型上下线跟随 App）。
  const refreshTimer = setInterval(() => {
    syncCatalog().catch((error) => {
      ctx.logger?.debug?.(`[${PLUGIN_ID}] 目录刷新失败: ${error.message}`);
    });
  }, Math.max(5, liveValue(config.refreshMinutes) ?? 30) * 60_000);
  refreshTimer.unref?.();

  // volatile-only 的配置变更不会重载插件（apply 不重跑，见 Config 注释），这里
  // 每 60s 比对一次配置指纹，变化即重新同步目录：开关/分组/白名单最迟 60s 生效。
  const configFingerprint = () => JSON.stringify([
    liveValue(config.enabled),
    liveValue(config.enabledGroups),
    liveValue(config.enabledModelIds),
    liveValue(config.refreshMinutes),
  ]);
  let fingerprint = configFingerprint();
  const watchTimer = setInterval(() => {
    let next;
    try { next = configFingerprint(); } catch { return; }
    if (next === fingerprint) return;
    fingerprint = next;
    ctx.logger?.info?.(`[${PLUGIN_ID}] 检测到配置变更，重建模型目录…`);
    syncCatalog().catch((error) => {
      ctx.logger?.warn?.(`[${PLUGIN_ID}] 配置变更后的目录重建失败: ${error.message}`);
    });
  }, 60_000);
  watchTimer.unref?.();

  ctx.on('dispose', () => {
    clearInterval(refreshTimer);
    clearInterval(watchTimer);
    releaseAll();
  });

  const summary = currentEntries
    .map((e) => `${e.group.code}=${e.profiles.length}`)
    .join(', ');
  ctx.logger?.info?.(`[${PLUGIN_ID}] 已挂载分组模型 ${currentEntries.reduce((n, e) => n + e.profiles.length, 0)} 个（${summary}）` +
    (firstError ? `（启动时目录拉取失败: ${firstError.message}）` : ''));
}

//#endregion
