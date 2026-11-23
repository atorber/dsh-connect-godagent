/**
 * dsh-connect-godagent · 客户端设置页（参考 dsh-connect-workbuddy 的 settings.section 范式）。
 *
 * 宿主协议（从 dsh-client-modules README 与 workbuddy 5.31.1 实现核对）：
 *  - client 入口是 `window.__ModuleLoader__.load({ id: <包名>, factory })` 形式的
 *    Lazy-CJS 工厂；react / react-dom 由平台种子表（PLATFORM_MODULES）提供，直接 require。
 *  - package.json 需要 `dsh.client: { platform: 'web', inject: [...] }` 与
 *    `exports['./client']`；宿主把启用插件的 client bundle 组进 /plugins 引导图。
 *  - 设置面板导航：`ctx.slots.inject('settings.section', cb)` 后
 *    `ctx.slots.register({ name: 'settings.section', id, order, label }, Component)`；
 *    图标同法注册 `settings.section.icon`（shell 以 `{ only: row.id }` 渲染）。
 *  - 配置读写：`ctx.get('configForms')` 的 `whileServed(nsCandidates, cb)` 等到宿主
 *    describe 出本插件 namespace 后 `forms.get(ns)` 拿 ConfigFormController：
 *    `getSnapshot().value`（宿主解析后的完整 Config）、`subscribe`、`set(field, value)`。
 *  - 分组目录：`GET https://gptgod.online/api/god-agent/groups` 公开且 CORS 全开
 *    （实测 access-control-allow-origin: *），client 直接拉取展示勾选。
 */
window.__ModuleLoader__.load({
	id: 'dsh-connect-godagent',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		const react = require('react');
		const { useState, useEffect, useMemo, useCallback } = react;

		const PLUGIN_ID = 'dsh-connect-godagent';
		const GROUPS_URL = 'https://gptgod.online/api/god-agent/groups';

		//#region 轻量内联样式（跟随主题变量，缺省回落暗色值）
		const S = {
			page: { display: 'flex', flexDirection: 'column', gap: 14, padding: 0, minHeight: 0 },
			head: {
				display: 'grid', gridTemplateColumns: 'auto minmax(0,1fr)', columnGap: 10, rowGap: 2,
				alignItems: 'center', background: 'var(--dsw-alias-bg-layer-1,#17181b)',
				borderRadius: 12, padding: '10px 12px',
			},
			title: { fontSize: 15, lineHeight: '22px', fontWeight: 600, color: 'var(--dsw-alias-label-primary,#e8e9ed)' },
			desc: { gridColumn: '1/-1', fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary,#b8bcc4)' },
			card: {
				display: 'flex', flexDirection: 'column', gap: 12,
				background: 'var(--dsw-alias-bg-layer-1,#17181b)', borderRadius: 12, padding: '12px 14px',
			},
			fieldTitle: { fontSize: 12, fontWeight: 600, color: 'var(--dsw-alias-label-primary,#e8e9ed)', margin: 0 },
			hint: { fontSize: 11, lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary,#8a8f98)', margin: '2px 0 0' },
			input: {
				font: 'inherit', fontSize: 12, lineHeight: '20px', width: '100%', boxSizing: 'border-box',
				fontFamily: 'ui-monospace,SFMono-Regular,Menlo,Consolas,monospace', padding: '5px 8px', borderRadius: 6,
				color: 'var(--dsw-alias-label-primary,#e8e9ed)', background: 'var(--dsw-alias-bg-l1,transparent)',
				border: '1px solid var(--dsw-alias-border-l2,#3a3d45)',
			},
			textarea: {
				font: 'inherit', fontSize: 12, lineHeight: '18px', width: '100%', boxSizing: 'border-box',
				fontFamily: 'ui-monospace,SFMono-Regular,Menlo,Consolas,monospace', padding: '6px 8px', borderRadius: 6,
				minHeight: 52, resize: 'vertical', color: 'var(--dsw-alias-label-primary,#e8e9ed)',
				background: 'var(--dsw-alias-bg-l1,transparent)', border: '1px solid var(--dsw-alias-border-l2,#3a3d45)',
			},
			row: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--dsw-alias-label-primary,#e8e9ed)' },
			check: { accentColor: 'var(--dsw-alias-brand-primary,#5686fe)', width: 14, height: 14, flex: 'none', cursor: 'pointer' },
			groupList: { display: 'flex', flexDirection: 'column', gap: 2, marginTop: 6 },
			groupRow: {
				display: 'flex', alignItems: 'center', gap: 8, padding: '4px 6px', borderRadius: 6,
				fontSize: 12, cursor: 'pointer', color: 'var(--dsw-alias-label-primary,#e8e9ed)',
			},
			groupRowHover: { background: 'var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12))' },
			badge: {
				flex: 'none', fontSize: 10, lineHeight: '14px', padding: '0 6px', borderRadius: 999,
				background: 'var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.16))',
				color: 'var(--dsw-alias-label-secondary,#b8bcc4)',
			},
			groupName: { color: 'var(--dsw-alias-label-secondary,#b8bcc4)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
			button: {
				alignSelf: 'flex-start', appearance: 'none', border: 0, cursor: 'pointer',
				font: 'inherit', fontSize: 12, fontWeight: 600, lineHeight: '24px', padding: '2px 14px', borderRadius: 8,
				background: 'var(--dsw-alias-brand-primary,#5686fe)', color: 'var(--dsw-alias-brand-label,#fff)',
			},
			buttonDisabled: { opacity: 0.55, cursor: 'default' },
			status: { fontSize: 11, lineHeight: '16px', color: 'var(--dsw-alias-label-secondary,#b8bcc4)' },
			statusError: { color: '#e5697a' },
			navIcon: { borderRadius: 4, display: 'block' },
		};
		//#endregion

		//#region 分组目录（公开接口，CORS 全开）
		async function fetchGroups() {
			const response = await fetch(GROUPS_URL, { headers: { accept: 'application/json' } });
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			const body = await response.json();
			if (body?.code !== 0 || !Array.isArray(body?.data)) throw new Error(body?.msg || '响应格式不符');
			return body.data;
		}
		//#endregion

		//#region 设置卡片
		/** 与 workbuddy 的 WorkBuddyCard 相同的 props 约定：inject 返回 { t, settingsScope, surface }。 */
		function GodAgentSettingsCard({ settingsScope }) {
			const snapshot = settingsScope?.getSnapshot?.();
			const ready = snapshot?.status === 'ready' && snapshot.value && typeof snapshot.value === 'object';
			const server = ready ? snapshot.value : {};

			/** 本地草稿：undefined = 未编辑（跟随服务端值）。字段级编辑后切到草稿值。 */
			const [draft, setDraft] = useState(undefined);
			const [groups, setGroups] = useState(undefined); // undefined=加载中, []=失败/空
			const [groupError, setGroupError] = useState('');
			const [busy, setBusy] = useState(false);
			/** 等待超过 12s 后提示硬刷新（宿主重启后 WS 重连不会重拉 describe mirror）。 */
			const [slow, setSlow] = useState(false);
			useEffect(() => {
				if (ready) { setSlow(false); return undefined; }
				const t = setTimeout(() => setSlow(true), 12000);
				return () => clearTimeout(t);
			}, [ready]);
			const [note, setNote] = useState(''); // 保存结果 { ok, text }
			const [hoverRow, setHoverRow] = useState('');

			// 服务端值变化（保存回包 / 其他端修改）时丢弃草稿，回到权威值。
			useEffect(() => settingsScope?.subscribe?.(() => setDraft(undefined)), [settingsScope]);

			useEffect(() => {
				let alive = true;
				fetchGroups()
					.then((data) => { if (alive) setGroups(data); })
					.catch((error) => { if (alive) { setGroups([]); setGroupError(error.message); } });
				return () => { alive = false; };
			}, []);

			const value = useMemo(() => ({ ...server, ...(draft ?? {}) }), [server, draft]);
			const patch = useCallback((fields) => {
				setNote('');
				setDraft((prev) => ({ ...(prev ?? server), ...fields }));
			}, [server]);

			const enabledGroups = Array.isArray(value.enabledGroups) ? value.enabledGroups : [];
			const modelIdsText = Array.isArray(value.enabledModelIds) ? value.enabledModelIds.join(', ')
				: typeof value.enabledModelIds === 'string' ? value.enabledModelIds : '';

			const save = useCallback(async () => {
				if (!settingsScope || busy) return;
				setBusy(true);
				setNote('');
				try {
					const next = { ...(draft ?? server) };
					const modelIds = modelIdsText.split(/[\s,，]+/).map((s) => s.trim()).filter(Boolean);
					const groups$1 = ['default', ...enabledGroups.filter((c) => c !== 'default')];
					const fields = {
						enabled: value.enabled !== false,
						apiKey: String(next.apiKey ?? '').trim(),
						enabledGroups: groups$1,
						enabledModelIds: modelIds,
						refreshMinutes: Math.max(5, Math.round(Number(next.refreshMinutes) || 30)),
					};
					let ok = true;
					for (const [field, v] of Object.entries(fields)) {
						if (!(await settingsScope.set(field, v))) ok = false;
					}
					setNote(ok
						? { ok: true, text: '已保存 · 模型目录正在按新配置重建（分组 key 首次启用时自动创建）' }
						: { ok: false, text: '保存未生效：宿主拒绝了写入，请查看设置面板的错误说明' });
					if (ok) setDraft(undefined);
				} catch (error) {
					setNote({ ok: false, text: `保存失败：${error?.message ?? error}` });
				} finally {
					setBusy(false);
				}
			}, [settingsScope, busy, draft, server, value, modelIdsText, enabledGroups]);

			const dirty = draft !== undefined;

			return react.createElement('div', { style: S.page },
				// 页头
				react.createElement('div', { style: S.head },
					react.createElement(NavIcon, { size: 28 }),
					react.createElement('div', { style: S.title }, 'God Agent (gptgod)'),
					react.createElement('div', { style: S.desc },
						'把本机 God Agent / gptgod 接入 DSH：按分组倍率接入全部聊天模型，费率显示在模型选择器里。配置改动保存后自动重建模型目录。'),
				),
				// 表单
				react.createElement('div', { style: S.card },
					// 总开关
					react.createElement('label', { style: { ...S.row, cursor: 'pointer' } },
						react.createElement('input', {
							type: 'checkbox', style: S.check, checked: value.enabled !== false,
							onChange: (e) => patch({ enabled: e.target.checked }),
						}),
						'启用 God Agent (gptgod) 模型接入',
					),
					// API Key
					react.createElement('div', null,
						react.createElement('p', { style: S.fieldTitle }, 'API Key（可选，default 分组）'),
						react.createElement('input', {
							style: S.input, type: 'text', placeholder: 'sk-…（留空 = 自动创建并管理 DSH GodAgent 专用 key）',
							value: String(value.apiKey ?? ''), onChange: (e) => patch({ apiKey: e.target.value }),
							spellCheck: false,
						}),
						react.createElement('p', { style: S.hint },
							'仅作用于 default 分组；其他分组各用一枚自动创建的专用 key（标题「DSH GodAgent · 分组」），在 gptgod 控制台可管理。'),
					),
					// 分组
					react.createElement('div', null,
						react.createElement('p', { style: S.fieldTitle }, '启用分组'),
						react.createElement('p', { style: S.hint }, '每个分组一份独立模型清单与计费倍率（默认分组 1× 恒启用）；同名模型按倍率从低到高排序，模型选择器直接显示折算后的实际费率。'),
						groups === undefined
							? react.createElement('p', { style: S.status }, '正在读取分组目录…')
							: react.createElement('div', { style: S.groupList },
								groups.length === 0
									? react.createElement('p', { style: { ...S.status, ...(groupError ? S.statusError : {}) } },
										groupError ? `分组目录读取失败：${groupError}` : '分组目录为空')
									: groups.map((group) => {
										const code = group.code;
										const isDefault = code === 'default';
										const checked = isDefault || enabledGroups.includes(code);
										const mult = Number(group.multiplier ?? 1);
										return react.createElement('label', {
											key: code, style: { ...S.groupRow, ...(hoverRow === code ? S.groupRowHover : {}) },
											onMouseEnter: () => setHoverRow(code), onMouseLeave: () => setHoverRow(''),
										},
											react.createElement('input', {
												type: 'checkbox', style: S.check, checked, disabled: isDefault,
												onChange: (e) => {
													const next = new Set(enabledGroups);
													if (e.target.checked) next.add(code); else next.delete(code);
													patch({ enabledGroups: [...next] });
												},
											}),
											react.createElement('span', { style: { fontFamily: 'ui-monospace,SFMono-Regular,Menlo,Consolas,monospace' } }, code),
											react.createElement('span', { style: S.groupName }, group.name || ''),
											react.createElement('span', { style: S.badge }, `${mult}×`),
											Number.isFinite(Number(group.model_count)) ? react.createElement('span', { style: S.badge }, `${group.model_count} 模型`) : null,
											group.description ? react.createElement('span', { style: { ...S.groupName, fontSize: 11 } }, group.description) : null,
										);
									}),
							),
					),
					// 模型白名单
					react.createElement('div', null,
						react.createElement('p', { style: S.fieldTitle }, '模型白名单（可选）'),
						react.createElement('textarea', {
							style: S.textarea, placeholder: '留空 = 接入全部聊天模型；填写模型 id（逗号或换行分隔）只接入这些模型，跨所有启用分组生效',
							value: modelIdsText, onChange: (e) => patch({ enabledModelIds: e.target.value }), spellCheck: false,
						}),
					),
					// 刷新周期
					react.createElement('div', { style: S.row },
						react.createElement('label', { style: S.row, htmlFor: 'dsh-godagent-refresh' }, '目录刷新周期'),
						react.createElement('input', {
							id: 'dsh-godagent-refresh', style: { ...S.input, width: 72 }, type: 'number', min: 5,
							value: String(value.refreshMinutes ?? 30), onChange: (e) => patch({ refreshMinutes: e.target.value }),
						}),
						react.createElement('span', { style: S.hint }, '分钟'),
					),
					// 保存
					react.createElement('div', { style: { ...S.row, gap: 10 } },
						react.createElement('button', {
							style: { ...S.button, ...(busy || !ready || !dirty ? S.buttonDisabled : {}) },
							disabled: busy || !ready || !dirty, onClick: save,
						}, busy ? '保存中…' : '保存'),
						!ready ? react.createElement('span', { style: S.status },
						snapshot?.status === 'unavailable'
							? '宿主未提供 God Agent 配置表单（硬刷新页面 / 重启 DSH 后重试）'
							: (slow
								? '等待God Agent主配置就绪...（宿主重启过？配置状态可能已过期——请硬刷新页面 Cmd+Shift+R）'
								: '等待God Agent主配置就绪...')) : null,
						dirty && ready && !busy ? react.createElement('span', { style: S.status }, '有未保存的修改') : null,
						note ? react.createElement('span', { style: { ...S.status, ...(note.ok ? {} : S.statusError) } }, note.text) : null,
					),
				),
			);
		}
		//#endregion

		//#region 导航图标（内联 SVG，无需静态资源路由）
		function NavIcon({ size = 16, active = true }) {
			return react.createElement('svg', {
				width: size, height: size, viewBox: '0 0 32 32', style: S.navIcon,
				opacity: active === false ? 0.75 : 1, 'aria-hidden': true,
			},
				react.createElement('rect', { x: 1, y: 1, width: 30, height: 30, rx: 8, fill: '#5686fe' }),
				react.createElement('path', {
					d: 'M22.5 12.2a7.4 7.4 0 1 0 .5 3.4h-6.6v2.9h3.5a4.6 4.6 0 1 1-1.2-4.6l2.1-2.1a7.4 7.4 0 0 0-12.3 5.4 7.4 7.4 0 0 0 13.9 3.5z',
					fill: '#fff',
				}),
				react.createElement('circle', { cx: 23.5, cy: 23.5, r: 3.2, fill: '#ffd257' }),
			);
		}
		//#endregion

		//#region 入口
		const inject = ['slots'];

		function apply(ctx) {
			try {
				const softGet = (name) => ctx.get(name);

				/** settingsScope 晚绑定：宿主 describe 出本插件 namespace 后才可用（whileServed 边沿触发）。 */
				let settingsScope;
				let liveDisposers = [];

				const registerAllSlots = () => {
					const disposers = [];
					try {
						const sectionInject = ctx.slots.inject('settings.section', () => ctx.slots.register({
							name: 'settings.section',
							id: PLUGIN_ID,
							order: 36,
							label: () => 'God Agent',
							inject: () => ({ settingsScope, surface: 'settings' }),
						}, GodAgentSettingsCard));
						disposers.push(sectionInject);
					} catch (error) {
						console.error('[dsh-connect-godagent] settings section failed to register:', error);
					}
					try {
						const iconInject = ctx.slots.inject('settings.section.icon', () => ctx.slots.register({
							name: 'settings.section.icon',
							id: PLUGIN_ID,
						}, NavIcon));
						disposers.push(iconInject);
					} catch (error) {
						console.error('[dsh-connect-godagent] settings nav icon failed to register:', error);
					}
					return disposers;
				};

				const rebindSlots = () => {
					for (const dispose of liveDisposers) try { dispose(); } catch {}
					liveDisposers = registerAllSlots();
				};

				const forms = softGet('configForms');
				const candidates = [PLUGIN_ID, `include:${PLUGIN_ID}`];
				if (forms && typeof forms.whileServed === 'function') {
					ctx.effect(() => forms.whileServed(candidates, (served) => {
						const ns = candidates.find((candidate) => served.has(candidate))
							?? [...served].find((entry) => /godagent/i.test(entry));
						settingsScope = ns === undefined ? undefined : forms.get(ns);
						rebindSlots();
						return () => {
							for (const dispose of liveDisposers) try { dispose(); } catch {}
							liveDisposers = [];
						};
					}), 'dsh-connect-godagent: settings namespace binding');
				} else {
					console.warn('[dsh-connect-godagent] configForms 服务不可用，设置页不可用（模型接入不受影响）');
				}
				rebindSlots();
			} catch (error) {
				console.error('[dsh-connect-godagent] client card failed to load (host provider unaffected):', error);
			}
		}
		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		exports.name = PLUGIN_ID;
		return module.exports;
	},
});
