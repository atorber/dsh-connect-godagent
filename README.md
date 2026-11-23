# dsh-connect-godagent

把本机登录的 [God Agent](https://gptgod.online) 桌面 App（gptgod.online 中转）的模型接入 DSH。

参考 [dsh-connect-workbuddy](https://github.com/dingminhua/dsh-connect-workbuddy) 的实现思路（pi-ai Provider + PiAiAdapter 装配范式）。

## 工作原理

1. **凭据复用**（按优先级）：
   - God Agent 把会话 cookie（`EGG_SESS` + `EGG_SESS.sig`）存在
     `~/Library/Caches/com.xiangsx.godagent/.cookies`；
   - cookie 失效时读取 Keychain 里的 refresh_token
     （`security find-generic-password -s com.xiangsx.godagent -w`），
     调 `POST /api/user/app-refresh-login` 换新会话。
     **refresh_token 是单次轮换的**，拿到新值立刻写回 Keychain（`-U` 更新），
     与 App 共享同一凭据槽。
2. **API Key**：自动在 gptgod 创建一枚 `title="DSH GodAgent"` 的 sk- key
   （gptgod 的 key 全文只在创建响应出现，因此存进
   `~/.dsh/godagent-connect/state.json`，0600；state 丢失时删旧建新保证幂等）。
   也可在插件设置里显式填 `apiKey`。
3. **模型目录**：`GET https://api.gptgod.online/v1/models`（Bearer sk-），
   能力元数据（vision / reasoning / context_window / max_output_tokens）取自
   God Agent App 本地 `cap-cache.json`（App 自己对每模型×格式做过真实探测；
   openai 格式探测失败的模型默认排除，可用 `enabledModelIds` 显式点名覆盖）。

## 分组（多倍率）

gptgod 的模型按**分组**计费（倍率 0.3×–5× 不等），分组由 API key 绑定
（请求头/模型名前缀均无效，实测）。因此插件为每个启用分组自动创建一枚
专用 key（`DSH GodAgent · <分组code>`），并注册为独立 provider：

| provider id | 说明 |
| --- | --- |
| `godagent` | default 分组（1×，账户级模型目录） |
| `godagent:<分组code>` | 其他分组，如 `godagent:cc-cheap`（0.4×）、`godagent:codex`（0.3×） |

- 分组清单来自公开接口 `GET /api/god-agent/groups`（缓存 6h），
  含 `name/multiplier/models/pricing`；倍率会显示在 provider 名称上。
- **非 default 分组的 `models` 清单即权威**（`/v1/models` 只反映 default 组的面），
  分组专属模型（如 codex 组的 `gpt-6-sol`）直接从清单注册。
- `enabledGroups` 设置控制启用哪些分组（留空 = 仅 default，`default` 永远保留）；
  `enabledModelIds` 白名单跨分组按裸模型 id 生效。

## 费率展示

模型选择器的行文案（模型显示名）直接带费率后缀，格式按 gptgod 的
`billing_type` 区分：

| 计费类型 | 显示 | 说明 |
| --- | --- | --- |
| `official` | `claude-opus-5 · $2/$10` (cc-cheap 0.4×) | 接口官方美元价 × 分组倍率 = 实际美元/百万 token（输入/输出）；cost 字段同步用折算后实际价，供宿主成本统计 |
| `times` | `claude-haiku-4-5-20251001 · 100分/次` | 积分/次 × 倍率（按秒的显示 `分/秒`） |
| `token` | `gemini-3-pro · 0.02/0分/M` | 积分计价 × 倍率（非美元） |
| `characters` | `· 按字符` | 按字符计费 |

价格全部取自公开接口 `GET /api/god-agent/groups` 返回的
`pricing` + `multiplier` 并直接相乘，展示的就是该分组的实际费率；
分组倍率另显示在 provider 名称上（如 `God Agent · ClaudeCode 青春版 (0.4×)`）。
provider 目录按倍率升序注册，搜索同名模型时回车直选最便宜分组。

## 设置项

**GUI 设置页**：设置 → God Agent（参考 WorkBuddy 的 `settings.section` 范式注册）。
可视化编辑以下全部字段：分组列表从公开接口实时拉取（带倍率/模型数徽章），
保存后模型目录按新配置自动重建；分组 key 首次启用时自动创建。

**volatile 生效机制**：全部字段都标 schemastery `.volatile()`——DSH 设置页
（`dsh-settings` 的 `volatileForm`）只展示带 `meta.volatile` 标记的字段，普通标量
Config 的整个 namespace 会从 `settings.describe()` 消失（表现为"等待宿主配置就绪…"）。
代价是 volatile-only 变更不重载插件（apply 不重跑），宿主侧由 60s 配置指纹巡检
补偿：enabled/enabledGroups/enabledModelIds/refreshMinutes 任一变化即重新拉目录并
重注册（先 dispose 旧句柄），最迟 60s 生效；停用开关会注销全部 provider。

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 启用 God Agent (gptgod) 模型接入 |
| `apiKey` | `''` | gptgod API Key（sk-…），仅用于 default 分组；其余分组自动创建 |
| `enabledGroups` | `[]` | 启用的分组 code（留空 = 仅 default），如 `cc-cheap`/`codex`/`aws-vip` |
| `enabledModelIds` | `[]` | 只启用这些模型 id（留空 = 全部聊天模型） |
| `refreshMinutes` | `30` | 模型目录刷新周期（分钟） |

实现：`lib/client.js` 为 Lazy-CJS 工厂（`window.__ModuleLoader__.load`），
经 `ctx.slots.inject('settings.section')` 注册页面、`settings.section.icon` 注册
导航图标；配置读写走 `configForms` 服务的 `ConfigFormController`
（`whileServed` 晚绑定宿主 namespace）。`test-client.mjs` 用 mock 平台模块
单测注册与渲染全链路（18 项断言）。

## 注意

- 模型调用直接走 `https://api.gptgod.online/v1`（openai-completions），
  计费落在你的 gptgod 账户积分上。
- 本插件只读 App 的凭据与缓存文件，不写 App 数据目录（Keychain 的
  refresh_token 轮换除外，这与 App 自身行为一致）。
- God Agent App 未登录时插件无法工作（无凭据可复用）。

## 在 DSH 中安装（一句话）

对 DSH 助手说这一句即可：

> 安装 dsh-connect-godagent 插件，仓库地址 https://github.com/atorber/dsh-connect-godagent

助手只需要执行**一条命令**（脚本自动完成：git 依赖安装 + bundles 注册 +
patch 挂载条目，幂等可重复执行）：

```bash
curl -fsSL https://raw.githubusercontent.com/atorber/dsh-connect-godagent/main/install.sh | bash
# raw.githubusercontent 不可达时（网络受限）：
curl -fsSL https://gcore.jsdelivr.net/gh/atorber/dsh-connect-godagent@main/install.sh | bash
```

- 默认装到 `web` profile；其它 profile 在后面加参数：`… | bash -s -- <profile名>`
- 完成后**重启 DSH**（`dsh web`）生效；GUI「设置 → God Agent」出现配置卡片

### 从本仓库安装（手动方式）

**方法一：git 依赖**

在 profile 目录（`$DSH_HOME/profiles/web`，可用 `dsh web` 启动参数
`--profile <name>` 指定其它 profile）执行：

```bash
cd $DSH_HOME/profiles/web

# 1. 把仓库装成 git 依赖
dsh plugin --profile web add "git+https://github.com/atorber/dsh-connect-godagent.git"
# （不用 dsh CLI 的话等价于：pnpm add "git+https://github.com/atorber/dsh-connect-godagent.git"）

# 2. profile/package.json 的 dsh.profile.bundles 数组追加 "dsh-connect-godagent"
# 3. profile/cordis.patch.yml 追加两行：
#    - id: dsh-connect-godagent
#      name: dsh-connect-godagent
# 4. 重启 DSH
```

> **务必写全 `git+https://` 前缀**。写成 `github:atorber/dsh-connect-godagent`
> 短格式时 pnpm 会解析成 `git+ssh://git@github.com/...`，未配置 SSH key 的机器
> 会报 `Permission denied (publickey)`。

安装即生效，无需 pnpm approve-builds：本包没有任何 build 脚本，依赖全部由
DSH 宿主提供（profile 树内的插件在加载时由 DSH Loader 把裸导入重路由到宿主
DSH 自带副本，见下文「依赖策略」）。

* **方法二：clone + link:**（本地开发推荐，源码改动即时生效）


```bash
git clone https://github.com/atorber/dsh-connect-godagent.git /path/to/dsh-connect-godagent

# profile: $DSH_HOME/profiles/web/package.json
"dsh-connect-godagent": "link:/path/to/dsh-connect-godagent"
# dsh.profile.bundles 追加 "dsh-connect-godagent"
# cordis.patch.yml 追加 `- id: dsh-connect-godagent / name: dsh-connect-godagent`
# 重启 DSH
```

link: 模式下依赖经 symlink 解析（目录里有 node_modules 时），源码改动无需重新
拷贝，重启 DSH 即生效；方法一为纯快照安装，更新需重新 `pnpm add` 拉取。

两种方法安装后，GUI「设置 → God Agent」应出现本插件的配置卡片
（启用开关 / 分组复选 / 模型白名单等）。

## 本地开发 / 安装

（开发期调试也可直接把仓库以 `link:` 依赖挂进 DSH profile，方法同上。）

- **依赖策略：零自带副本**。`package.json` 不声明任何 DSH 公共包
  （`@deepseek-ai/dsh-llm`、`@deepseek-ai/cordis`、`@earendil-works/pi-ai` 等）为
  dependencies，只保留 peerDependencies 声明运行时契约；本地 `node_modules/` 里
  这些包是**指向宿主 DSH 自带副本的 symlink**
  （`ln -s <DSH>/node_modules/@deepseek-ai/dsh-llm node_modules/@deepseek-ai/`）。
  Node 沿 realpath 解析后与宿主加载同一物理模块（单副本，require cache 同 key），
  避免 DSH 升级后出现两份版本漂移的 dsh-llm/pi-ai 互相干扰。`.npmrc`
  `auto-install-peers=false` 防止 pnpm 意外把 peer 拉成本地实体。
  （cordis 服务访问仍需 `export const inject = ['llm']`。）
- 冒烟测试：`node test-e2e.mjs [providerId] [modelId] [reasoningEffort]`。
