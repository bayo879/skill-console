/**
 * dsh-skill-console — 浏览器半边（设置 →「技能控制台」）。
 *
 * 一个挂载点，两个标签页：
 *
 *   1. 「技能」——按 全局 / 项目 看技能目录，逐项启停（宿主用重命名发现文件实现，
 *      绝不改写内容），并把「同名技能谁生效」讲清楚：collisions + toggle 返回的 takeover。
 *   2. 「技能仓库」——订阅 GitHub 仓库、**手动**拉取最新、逐项确认安装/更新、恢复备份。
 *
 * 为什么只有一个挂载点：这个插件的全部语义都是「配置面」，没有需要常驻的运行时
 * 视图（不像集群面板要浮层）。设置分区是它唯一的家，也就没有第二个注册点。
 *
 * 契约的唯一来源是 `docs/HTTP-API.md`（冻结版 v1）。这里所有端点都拼在
 * `/api/skill-console` 前缀下。
 *
 * 三条写死的规矩：
 *   - 会话头：每个请求都带 `x-skill-console-session: <sessionId>`（拿得到就带）。
 *     宿主用它把「项目」解析成该会话的 `header.cwd`；拿不到就回落到它自己的默认值，
 *     并在 `data.project.fallback === true` 里明说——**前端必须把这件事显示出来**，
 *     否则用户会以为在看当前项目的技能，其实看的是别人的。
 *   - 写操作 POST 一律带 `content-type: application/json` + `x-skill-console: 1`。
 *     宿主靠这两个头做跨站围栏，少一个就是 403/415。
 *   - 从不自动更新：拉取/安装/恢复全部由用户点击触发，没有轮询、没有定时器。
 *
 * 打包格式：手写的 DSH 客户端 bundle（`window.__ModuleLoader__.load` 的 lazy-CJS 表项），
 * 只 require `react` 与 shell 提供的 primitives——**没有构建步骤、没有 npm 依赖**。
 * primitives 取不到就退回原生元素，功能等价（只是少了产品级的观感）。
 *
 * 失败策略：挂载问题只记日志，绝不抛。客户端插件抛错会让整个 web shell 的 boot 失败，
 * 外部插件不能把别人的界面拖下去。
 */

window.__ModuleLoader__.load({
	id: 'dsh-skill-console',
	factory: (require) => {
		var module = { exports: {} }
		var exports = module.exports
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

		const react = require('react')
		const h = react.createElement

		/**
		 * 产品自带的 primitives（shell 的种子模块）。用它，颜色/hover/focus/图标槽
		 * 全部由产品负责；取不到就退回原生元素。所有取用都走 `primitive(name)`，
		 * 于是「缺哪个就用哪个的降级」只有一处判断。
		 */
		let primitives = null
		try {
			primitives = require('@deepseek-ai/dsh-client-ui-primitives')
		} catch (error) {
			console.warn('[dsh-skill-console] 取不到 dsh-client-ui-primitives，改用原生元素渲染：', error)
		}
		const primitive = (name) => (primitives && typeof primitives[name] === 'function' ? primitives[name] : null)

		// ── 常量 ────────────────────────────────────────────────────────────────

		/** 本地化命名空间（也是 `settings.section` 的 locale 字段）。 */
		const NS = 'skill-console'
		/** 宿主注册的 prefix 路由。 */
		const API = '/api/skill-console'
		/** 设置分区导航位置（集群面板 13、官方插件 15、技能管理器 17，这里占 14）。 */
		const SECTION_ORDER = 14
		/** 会话头：宿主用它把项目解析成该会话的 cwd。 */
		const SESSION_HEADER = 'x-skill-console-session'
		/** 写操作必须带的两个头（跨站围栏）。 */
		const WRITE_HEADERS = { 'content-type': 'application/json', 'x-skill-console': '1' }
		const STYLE_ID = 'dsh-skill-console-style'

		// ── i18n ───────────────────────────────────────────────────────────────

		/**
		 * 字典。zh + en 必须**键完全对齐**（缺一个键就会在另一种语言里露出 key）。
		 *
		 * 几个刻意的约定：
		 *   - 诊断/错误码直接当键用（`diagnostic.name.invalid` 就是 `t('diagnostic.name.invalid')`），
		 *     宿主只给机器码、不给文案，翻译归前端——这样中英一致，不会一半中文一半英文。
		 *   - `{name}` / `{count}` 占位符由 locale 服务插值（与官方插件同一套写法）。
		 */
		const DICT = {
			zh: {
				'section.label': '技能控制台',
				'section.title': '技能控制台',
				'section.version': '版本 {version}',
				'section.subtitle': '按全局 / 项目查看技能并启停；订阅 GitHub 仓库后手动拉取、逐项确认安装。不会自动更新。',
				'tab.skills': '技能',
				'tab.repos': '技能仓库',
				'tab.roles': '角色',
				'roles.subtitle': '把一组技能存成角色；切换角色即成套改变当前项目的技能。只写项目技能根，不动全局。',
				'roles.currentProject': '当前项目',
				'roles.noProject': '解析不出项目根（当前会话的目录不在任何项目里）',
				'roles.fallback': '没带上会话，正在用最近一个会话的项目——请确认这是你要管的项目。',
				'roles.empty': '还没有角色。新建一个，勾选这个项目要用的技能。',
				'roles.new': '新建角色',
				'roles.edit': '编辑',
				'roles.remove': '删除',
				'roles.removeConfirm': '删除角色「{name}」？磁盘上的技能文件一个都不会动。',
				'roles.activate': '切换到此角色',
				'roles.activateConfirm': '切换会把当前项目的技能对齐到这个角色：复制 {copy} 个、启用 {enable} 个、停用 {disable} 个。全局技能不受影响（复制只从全局读一份到项目，全局那份不会被改）。确定吗？',
				'roles.deactivate': '取消角色',
				'roles.deactivateConfirm': '取消角色的激活记录？磁盘上的技能保持现状，不会还原。',
				'roles.save': '保存',
				'roles.cancel': '取消',
				'roles.saveFirst': '先保存，再切换到这个角色',
				'roles.name': '角色名',
				'roles.namePlaceholder': '例如：前端开发',
				'roles.skillsCount': '{count} 个技能',
				'roles.statusUnassigned': '未启用角色',
				'roles.statusMatched': '已对齐角色',
				'roles.statusDrifted': '已偏离角色',
				'roles.statusDriftedHint': '项目技能与角色不一致（可能手工改过开关）。不会自动纠正，再切一次即可对齐。',
				'roles.projectSkills': '项目技能·角色可控制',
				'roles.globalSkills': '全局技能·不受角色控制',
				'roles.globalReadonly': '全局技能不受角色控制，切换角色后仍然生效',
				'roles.missingSkills': '角色里包含、但本项目没有的技能',
				'roles.missingHint': '这些名字在别的项目里可能有；在本项目里切换时会被跳过。',
				'roles.noProjectRoot': '这个项目还没有技能根（<项目根>/.dsh/skills 不存在）。',
				'roles.noCandidates': '项目技能根里还没有技能。',
				'roles.activateSummary': '复制 {copy} 个 / 启用 {enable} 个 / 停用 {disable} 个 / 跳过 {skipped} 个',
				'roles.copyCount': '复制 {count} 个',
				'roles.localKept': '项目里已有同名，保留本地副本',
				'roles.localKeptHint': '这些技能在这个项目里已经有一份，角色不会用全局那份覆盖它们。',
				'roles.takeover': '「{name}」停用后有同名技能接管生效',
				'roles.resultOk': '完成',
				'roles.resultSkipped': '跳过',
				'roles.resultFailed': '失败',
				'roles.loadFailed': '读不到角色列表',
				'roles.saveFailed': '保存失败',
				'roles.activateFailed': '切换失败',
				'common.refresh': '刷新',
				'common.loading': '正在加载…',
				'common.close': '关闭',
				'common.detail': '查看详情',
				'time.now': '刚刚',
				'time.minutes': '{n} 分钟前',
				'time.hours': '{n} 小时前',
				'time.days': '{n} 天前',
				'time.months': '{n} 个月前',
				'time.years': '{n} 年前',
				'time.unknown': '时间未知',
				'md.copy': '复制',
				'md.copied': '已复制',
				'md.footnotes': '脚注',
				'skills.scope': '范围',
				'skills.scope.global': '全局',
				'skills.scope.project': '项目',
				'skills.project': '当前项目',
				'skills.projectFallback': '没拿到当前会话，宿主回落到「{name}」——这不是当前会话的项目。',
				'skills.projectFallbackUnknown': '没拿到当前会话，宿主回落到它自己的默认项目。',
				'skills.projectName': '当前项目：{name}',
				'skills.noSessions': '当前没有活动会话，列不出项目技能。请在某个工作区里打开一个会话，再刷新。',
				'skills.empty': '这个范围里没有发现技能。',
				'skills.noDescription': '未提供简介',
				'skills.nameFromDirectory': 'frontmatter 没写 name，这里显示的是目录/文件名',
				'skills.status.enabled': '已启用',
				'skills.status.disabled': '已停用',
				'skills.status.invalid': '诊断异常',
				'skills.toggle': '启停技能',
				'skills.toggleAria': '启停 {name}',
				'skills.readOnlySymlink': '软链接技能不可启停：重命名会写到链接目标里去。',
				'skills.readOnlyOther': '不可启停：{reason}',
				'skills.source': '所属仓库',
				'skills.sourceLocal': '本地（非订阅）',
				'skills.installedTitle': '来自订阅 {id}（commit {commit}）',
				'skills.collisions': '同名技能冲突',
				'skills.collisionRow': '「{name}」由 {winner} 生效；{shadowed} 的副本被覆盖。',
				'skills.takeover': '「{name}」启停已更新；同名技能现在由 {roots} 生效。',
				'skills.toggled': '「{name}」已{state}。',
				'skills.stateOn': '启用',
				'skills.stateOff': '停用',
				'skills.batchEnable': '全部启用',
				'skills.batchDisable': '全部停用',
				'skills.batchResult': '已更新 {changed} 项。',
				'skills.batchFailed': '{failed} 项失败',
				'skills.delete': '删除',
				'skills.deleteConfirm': '删除{form}技能「{name}」（{root}）？会先整份备份，之后可以从备份恢复。',
				'skills.deleteSymlinkHint': '这是一个软链接：只删这个链接，不动它指向的技能。',
				'skills.deleteGlobalHint': '删的是全局技能，删掉后所有项目都不再加载它。',
				'skills.deleteDone': '已删除「{name}」，已先整份备份，可以从备份恢复',
				'skills.deleteFailed': '删除失败',
				'skills.move': '移到项目',
				'skills.moveConfirm': '把全局技能「{name}」移到当前项目（{project}）？全局那份会消失；项目里已有同名技能时会拒绝，不覆盖。',
				'skills.moveDone': '已把「{name}」移到当前项目技能根',
				// 宿主 `skillsMoveToProject` 已经把整句话写好了（含失败原因），这里只做透传，
				// 否则会渲染成「项目里已经就位，但全局那份没删掉：项目里已经就位，但全局那份没删掉：…」。
				'skills.movePartial': '{warning}',
				'skills.moveFailed': '移动失败',
				'skills.formFlat': '扁平文件',
				'skills.formDirectory': '目录包',
				'skills.formSymlink': '软链接',
				'skills.groupMissing': '目录不存在',
				'skills.groupCount': '{count} 个技能',
				'skills.detailTitle': '技能详情',
				'skills.detailFrontmatter': 'Frontmatter（原始 YAML）',
				'skills.detailBody': '正文',
				'skills.detailNoBody': '（没有正文）',
				'skills.detailLoading': '正在读取技能详情…',
				'skills.loading': '正在读取技能目录…',
				'roots.user-dsh': '全局 DSH',
				'roots.project-dsh': '项目 DSH',
				'diagnostic.frontmatter.missing': '缺少完整的 YAML frontmatter',
				'diagnostic.frontmatter.unclosed': 'frontmatter 的 --- 没有闭合',
				'diagnostic.frontmatter.invalid': 'frontmatter 不是合法 YAML',
				'diagnostic.name.missing': 'frontmatter 缺少 name',
				'diagnostic.name.invalid': 'name 不是合法 kebab-case',
				'diagnostic.description.missing': 'frontmatter 缺少 description',
				'diagnostic.symlink': '软链接技能（只读）',
				'diagnostic.unknown': '未知诊断',
				'error.file.read': '技能文件读取失败',
				'error.root.read': '技能根不可读',
				'error.repo.read': '仓库里的技能读取失败',
				'error.pathOutsideRoots': '该路径不在已知技能根内，已拒绝这次操作。',
				'error.toggleConflict': '同名目标文件已存在，拒绝覆盖；请刷新后重试。',
				'error.toggleSymlink': '软链接技能不允许启停（重命名会写到链接目标）。',
				'error.rateLimit': 'GitHub API 限流了。可以配环境变量 DSH_SKILL_CONSOLE_GITHUB_TOKEN 或 GITHUB_TOKEN 后重试。',
				'error.network': '网络请求失败，可以稍后重试。',
				'error.repoSubdirectory': '子目录不合法（不能是绝对路径、也不能含 ..），已拒绝这次编辑。',
				'error.repoState': '订阅状态文件损坏了，为避免覆盖你的数据，这次操作被拒绝。可以检查 DSH_HOME 下的 skill-console/repositories.json。',
				'error.backupNotFound': '没有可恢复的备份。',
				'error.endpointMissing': '后端接口没挂上（HTTP {status}）。通常是插件没被加载，或装好后还没重启 DSH。',
				'error.internal': '后端处理这次请求时抛了异常，没有改动任何文件。可以看 DSH 日志里的 web-server 警告。',
				'error.action': '操作失败：{error}',
				'repos.subscribed': '已订阅的仓库',
				'repos.tokenOn': '已配置 GitHub token',
				'repos.tokenOff': '未配置 GitHub token',
				'repos.empty': '还没有订阅任何仓库。在下面填 owner/name 或 GitHub 链接即可添加（添加时会立刻做一次首次拉取）。',
				'repos.statusLine': '共 {total}：未安装 {notInstalled} · 已安装 {installed} · 可更新 {updateAvailable} · 上游已删除 {upstreamDeleted}',
				'repos.statusExtra': '另有 frontmatter 异常 {invalid} · 本地冲突 {conflict}',
				'repos.ref': '分支 {ref}',
				'repos.refDefault': '默认分支',
				'repos.subdir': '子目录 {path}',
				'repos.lastFetchNever': '还没拉取过',
				'repos.lastFetchLine': '{commit} · {time} · {count} 个技能',
				'repos.lastFetchError': '上次拉取失败：{error}',
				'repos.fetch': '拉取最新',
				'repos.fetchTitle': '手动操作：只刷新远端清单，不会改动本地已安装技能',
				'repos.fetchHint': '「拉取最新」永远是你手动点的：它只把远端清单缓存到 DSH_HOME/skill-console/repository-cache，不碰本地技能文件。装什么、什么时候装，都由你逐项确认。',
				'repos.fetchDone': '已刷新「{id}」的远端清单。',
				'repos.remove': '移除订阅',
				'repos.removeConfirm': '移除订阅 {id}？已安装到本地的技能会原样保留（卸载订阅 ≠ 删除技能）。继续？',
				'repos.removed': '已移除订阅 {id}，本地保留 {count} 个技能。',
				'repos.edit': '编辑',
				'repos.editTitle': '编辑订阅 {id}',
				'repos.editHint': '改分支或子目录会立刻重新拉取远端清单（旧清单属于另一棵树，不能继续用）。地址不可改：换仓库请先移除订阅再加新的。',
				'repos.editSave': '保存',
				'repos.editCancel': '取消',
				'repos.editing': '正在保存并重新拉取…',
				'repos.edited': '已更新「{id}」的订阅设置。',
				'repos.editUnchanged': '「{id}」没有改动。',
				'repos.editFetchError': '订阅设置已保存，但重新拉取失败：{error}',
				'repos.expand': '展开',
				'repos.collapse': '收起',
				'repos.collapseAll': '全部收起',
				'repos.detailTitle': '仓库里的技能',
				'repos.detailEmpty': '这个订阅还没有远端清单，点「拉取最新」。',
				'repos.detailNoSkills': '这个仓库里没找到技能。仓库根目录下的 .md（README、CONTRIBUTING 之类）本身不算技能——如果技能放在子目录里，用「编辑」把子目录填对（例如 skills）。',
				'repos.detailLoading': '正在读取仓库技能…',
				'repos.skillCount': '{count} 个技能',
				'repos.skill.not-installed': '未安装',
				'repos.skill.installed': '已安装',
				'repos.skill.update-available': '可更新',
				'repos.skill.upstream-deleted': '上游已删除',
				'repos.skill.invalid': 'frontmatter 不合法',
				'repos.localModified': '本地有修改',
				'repos.conflict': '本地同名已存在',
				'repos.changedFiles': '变更',
				'repos.change.modified': '改',
				'repos.change.added': '增',
				'repos.change.removed': '删',
				'repos.change.unknown': '?',
				'repos.meta': '{files} 个文件 · {size}',
				'repos.install': '安装/更新选中',
				'repos.installNone': '先勾选要安装或更新的技能。',
				'repos.confirmOverwrite': '这些技能在本地有改动，安装会覆盖它们（覆盖前整份备份）：{names}。继续？',
				'repos.installResult': '安装结果',
				'repos.installedRow': '{name} · {state}',
				'repos.installedStateNew': '已安装',
				'repos.installedStateUpdated': '已更新',
				'repos.installedBackup': '备份：{path}',
				'repos.skippedRow': '{name} · 已跳过：{reason}',
				'repos.installDone': '已处理 {count} 个技能。',
				'repos.restore': '恢复上一版',
				'repos.restoreConfirm': '用备份（{time}）覆盖「{name}」的当前版本？当前版本会先再备份一次。',
				'repos.restoreNone': '「{name}」没有可恢复的备份。',
				'repos.restored': '已恢复「{name}」。',
				'repos.addTitle': '添加仓库',
				'repos.addUrl': '仓库',
				'repos.addUrlPlaceholder': 'obra/superpowers 或 https://github.com/obra/superpowers',
				'repos.addRef': '分支 / 标签（可空）',
				'repos.addRefPlaceholder': '默认分支',
				'repos.addSubdir': '子目录（可空）',
				'repos.addSubdirPlaceholder': 'skills',
				'repos.add': '添加仓库',
				'repos.adding': '正在添加并首次拉取…',
				'repos.added': '已订阅「{id}」。',
				'repos.addFetchError': '订阅已添加，但首次拉取失败：{error}',
				'repos.selectAll': '全选可更新',
				'repos.selectNone': '全不选',
				'repos.selected': '已选 {count} 个',
				'repos.installTarget': '安装到',
				'repos.targetGlobal': '全局技能根',
				'repos.targetProject': '当前项目技能根',
				'repos.targetProjectHint': '装到当前项目时，全局技能根不会被动；项目里已有同名技能需要确认才覆盖。',
			},
			en: {
				'section.label': 'Skill console',
				'section.title': 'Skill console',
				'section.version': 'Version {version}',
				'section.subtitle': 'Enable or disable skills per scope, and subscribe to GitHub skill repositories with manual fetches and per-skill installs. Nothing updates automatically.',
				'tab.skills': 'Skills',
				'tab.repos': 'Repositories',
				'tab.roles': 'Roles',
				'roles.subtitle': 'Save a set of skills as a role; switching roles swaps the current project\'s skills in one go. Only the project skill root is written — never the global one.',
				'roles.currentProject': 'Current project',
				'roles.noProject': 'No project root could be resolved (this session\'s directory is not inside a project).',
				'roles.fallback': 'No session was sent, so the most recent session\'s project is in use — please confirm this is the project you mean.',
				'roles.empty': 'No roles yet. Create one and tick the skills this project should use.',
				'roles.new': 'New role',
				'roles.edit': 'Edit',
				'roles.remove': 'Delete',
				'roles.removeConfirm': 'Delete the role "{name}"? No skill file on disk will be touched.',
				'roles.activate': 'Switch to this role',
				'roles.activateConfirm': 'Switching aligns this project\'s skills to the role: copy {copy}, enable {enable}, disable {disable}. Global skills are unaffected (copying only reads one from the global root into the project; the global copy is never changed). Continue?',
				'roles.deactivate': 'Clear role',
				'roles.deactivateConfirm': 'Clear this project\'s active-role record? Skills on disk stay as they are — nothing is restored.',
				'roles.save': 'Save',
				'roles.cancel': 'Cancel',
				'roles.saveFirst': 'Save first, then switch to this role',
				'roles.name': 'Role name',
				'roles.namePlaceholder': 'e.g. Frontend',
				'roles.skillsCount': '{count} skills',
				'roles.statusUnassigned': 'No role active',
				'roles.statusMatched': 'Aligned to role',
				'roles.statusDrifted': 'Drifted from role',
				'roles.statusDriftedHint': 'Project skills no longer match the role (toggles were changed by hand). Nothing is corrected automatically — switch again to realign.',
				'roles.projectSkills': 'Project skills · controlled by the role',
				'roles.globalSkills': 'Global skills · not controlled by roles',
				'roles.globalReadonly': 'Global skills are not controlled by roles and stay active after switching',
				'roles.missingSkills': 'In the role but missing from this project',
				'roles.missingHint': 'These names may exist in other projects; switching here skips them.',
				'roles.noProjectRoot': 'This project has no skill root yet (<projectRoot>/.dsh/skills does not exist).',
				'roles.noCandidates': 'The project skill root has no skills yet.',
				'roles.activateSummary': 'copy {copy} / enable {enable} / disable {disable} / skipped {skipped}',
				'roles.copyCount': 'copy {count}',
				'roles.localKept': 'A local copy already exists — keeping it',
				'roles.localKeptHint': 'These skills already exist in this project; the role will not overwrite them with the global copies.',
				'roles.takeover': 'After disabling "{name}", a same-named skill takes over',
				'roles.resultOk': 'done',
				'roles.resultSkipped': 'skipped',
				'roles.resultFailed': 'failed',
				'roles.loadFailed': 'Could not read the role list',
				'roles.saveFailed': 'Save failed',
				'roles.activateFailed': 'Switch failed',
				'common.refresh': 'Refresh',
				'common.loading': 'Loading…',
				'common.close': 'Close',
				'common.detail': 'View details',
				'time.now': 'just now',
				'time.minutes': '{n} min ago',
				'time.hours': '{n} h ago',
				'time.days': '{n} d ago',
				'time.months': '{n} mo ago',
				'time.years': '{n} y ago',
				'time.unknown': 'unknown time',
				'md.copy': 'Copy',
				'md.copied': 'Copied',
				'md.footnotes': 'Footnotes',
				'skills.scope': 'Scope',
				'skills.scope.global': 'Global',
				'skills.scope.project': 'Project',
				'skills.project': 'Project',
				'skills.projectFallback': 'No current session was available, so the host fell back to "{name}" — this is not the current session\'s project.',
				'skills.projectFallbackUnknown': 'No current session was available, so the host fell back to its own default project.',
				'skills.projectName': 'Current project: {name}',
				'skills.noSessions': 'There is no live session, so project skills cannot be listed. Open a session in a workspace, then refresh.',
				'skills.empty': 'No skills were found in this scope.',
				'skills.noDescription': 'No description provided',
				'skills.nameFromDirectory': 'Frontmatter has no name; the folder/file name is shown instead',
				'skills.status.enabled': 'Enabled',
				'skills.status.disabled': 'Disabled',
				'skills.status.invalid': 'Needs attention',
				'skills.toggle': 'Toggle skill',
				'skills.toggleAria': 'Toggle {name}',
				'skills.readOnlySymlink': 'A symlinked skill cannot be toggled: renaming it would write into the link target.',
				'skills.readOnlyOther': 'Cannot be toggled: {reason}',
				'skills.source': 'Source repo',
				'skills.sourceLocal': 'Local (not subscribed)',
				'skills.installedTitle': 'Installed from {id} (commit {commit})',
				'skills.collisions': 'Same-name collisions',
				'skills.collisionRow': '"{name}" is served by {winner}; the copies in {shadowed} are overridden.',
				'skills.takeover': '"{name}" was updated; that name is now served by {roots}.',
				'skills.toggled': '"{name}" is now {state}.',
				'skills.stateOn': 'enabled',
				'skills.stateOff': 'disabled',
				'skills.batchEnable': 'Enable all',
				'skills.batchDisable': 'Disable all',
				'skills.batchResult': '{changed} updated.',
				'skills.batchFailed': '{failed} failed',
				'skills.delete': 'Delete',
				'skills.deleteConfirm': 'Delete the {form} skill "{name}" ({root})? It is backed up in full first and can be restored from the backup.',
				'skills.deleteSymlinkHint': 'This is a symlink: only the link is deleted, the skill it points to is untouched.',
				'skills.deleteGlobalHint': 'This is a global skill; removing it stops every project from loading it.',
				'skills.deleteDone': 'Deleted "{name}"; a full backup was taken and can be restored',
				'skills.deleteFailed': 'Delete failed',
				'skills.move': 'Move to project',
				'skills.moveConfirm': 'Move the global skill "{name}" into the current project ({project})? The global copy will disappear; an existing same-named project skill makes this refuse rather than overwrite.',
				'skills.moveDone': 'Moved "{name}" into the current project skill root',
				// 宿主 `skillsMoveToProject` 已经把整句话写好了（含失败原因），这里只做透传。
				'skills.movePartial': '{warning}',
				'skills.moveFailed': 'Move failed',
				'skills.formFlat': 'flat file',
				'skills.formDirectory': 'directory package',
				'skills.formSymlink': 'symlink',
				'skills.groupMissing': 'Directory does not exist',
				'skills.groupCount': '{count} skills',
				'skills.detailTitle': 'Skill details',
				'skills.detailFrontmatter': 'Frontmatter (raw YAML)',
				'skills.detailBody': 'Body',
				'skills.detailNoBody': '(empty body)',
				'skills.detailLoading': 'Loading skill details…',
				'skills.loading': 'Loading skills…',
				'roots.user-dsh': 'Global DSH',
				'roots.project-dsh': 'Project DSH',
				'diagnostic.frontmatter.missing': 'Missing a complete YAML frontmatter',
				'diagnostic.frontmatter.unclosed': 'The frontmatter --- fence is not closed',
				'diagnostic.frontmatter.invalid': 'The frontmatter is not valid YAML',
				'diagnostic.name.missing': 'The frontmatter has no name',
				'diagnostic.name.invalid': 'The name is not valid kebab-case',
				'diagnostic.description.missing': 'The frontmatter has no description',
				'diagnostic.symlink': 'Symlinked skill (read-only)',
				'diagnostic.unknown': 'Unknown diagnostic',
				'error.file.read': 'Could not read the skill file',
				'error.root.read': 'Could not read the skill root',
				'error.repo.read': 'Could not read a skill in the repository',
				'error.pathOutsideRoots': 'That path is not inside a known skill root, so the operation was refused.',
				'error.toggleConflict': 'A same-name target file already exists; nothing was overwritten — refresh and try again.',
				'error.toggleSymlink': 'A symlinked skill cannot be toggled (the rename would write into the link target).',
				'error.rateLimit': 'The GitHub API rate limit was hit. Set DSH_SKILL_CONSOLE_GITHUB_TOKEN or GITHUB_TOKEN and try again.',
				'error.network': 'The network request failed; you can retry later.',
				'error.repoSubdirectory': 'Invalid subdirectory (it cannot be an absolute path or contain ..); the edit was refused.',
				'error.repoState': 'The subscription state file is corrupted, so this operation was refused to avoid overwriting your data. Check skill-console/repositories.json under DSH_HOME.',
				'error.backupNotFound': 'There is no backup to restore.',
				'error.endpointMissing': 'The backend endpoint is not mounted (HTTP {status}). Usually the plugin was not loaded, or DSH has not been restarted since installing it.',
				'error.internal': 'The backend threw while handling this request; nothing was changed on disk. Check the web-server warnings in the DSH log.',
				'error.action': 'Action failed: {error}',
				'repos.subscribed': 'Subscribed repositories',
				'repos.tokenOn': 'GitHub token configured',
				'repos.tokenOff': 'No GitHub token configured',
				'repos.empty': 'No repository is subscribed yet. Enter owner/name or a GitHub URL below to add one (adding performs one initial fetch).',
				'repos.statusLine': '{total} total: {notInstalled} not installed · {installed} installed · {updateAvailable} update available · {upstreamDeleted} upstream deleted',
				'repos.statusExtra': 'plus {invalid} invalid frontmatter · {conflict} local conflicts',
				'repos.ref': 'Ref {ref}',
				'repos.refDefault': 'Default branch',
				'repos.subdir': 'Subdirectory {path}',
				'repos.lastFetchNever': 'Never fetched',
				'repos.lastFetchLine': '{commit} · {time} · {count} skills',
				'repos.lastFetchError': 'Last fetch failed: {error}',
				'repos.fetch': 'Fetch latest',
				'repos.fetchTitle': 'Manual action: only refreshes the remote manifest, never touches installed skills',
				'repos.fetchHint': '"Fetch latest" only ever runs when you click it: it caches the remote manifest under DSH_HOME/skill-console/repository-cache and never touches local skill files. What to install, and when, stays your per-skill decision.',
				'repos.fetchDone': 'Refreshed the remote manifest of "{id}".',
				'repos.remove': 'Remove subscription',
				'repos.removeConfirm': 'Remove the subscription {id}? Skills already installed locally are kept (removing a subscription is not deleting skills). Continue?',
				'repos.removed': 'Removed the subscription {id}; {count} skills stay installed locally.',
				'repos.edit': 'Edit',
				'repos.editTitle': 'Edit subscription {id}',
				'repos.editHint': 'Changing the branch or subdirectory refetches the remote manifest immediately (the old manifest belongs to another tree). The address cannot be changed: remove the subscription and add the new repo instead.',
				'repos.editSave': 'Save',
				'repos.editCancel': 'Cancel',
				'repos.editing': 'Saving and refetching…',
				'repos.edited': 'Updated the subscription settings for "{id}".',
				'repos.editUnchanged': '"{id}" had no changes.',
				'repos.editFetchError': 'Settings saved, but the refetch failed: {error}',
				'repos.expand': 'Expand',
				'repos.collapse': 'Collapse',
				'repos.collapseAll': 'Collapse all',
				'repos.detailTitle': 'Skills in this repository',
				'repos.detailEmpty': 'This subscription has no remote manifest yet — click "Fetch latest".',
				'repos.detailNoSkills': 'No skill found in this repository. Top-level .md files (README, CONTRIBUTING and the like) are not skills by themselves — if the skills live in a subdirectory, use "Edit" to point the subdirectory at it (for example skills).',
				'repos.detailLoading': 'Loading repository skills…',
				'repos.skillCount': '{count} skills',
				'repos.skill.not-installed': 'Not installed',
				'repos.skill.installed': 'Installed',
				'repos.skill.update-available': 'Update available',
				'repos.skill.upstream-deleted': 'Deleted upstream',
				'repos.skill.invalid': 'Invalid frontmatter',
				'repos.localModified': 'Modified locally',
				'repos.conflict': 'Same name exists locally',
				'repos.changedFiles': 'Changes',
				'repos.change.modified': 'M',
				'repos.change.added': 'A',
				'repos.change.removed': 'D',
				'repos.change.unknown': '?',
				'repos.meta': '{files} files · {size}',
				'repos.install': 'Install / update selected',
				'repos.installNone': 'Select the skills you want to install or update first.',
				'repos.confirmOverwrite': 'These skills have local modifications and will be overwritten (each one is backed up first): {names}. Continue?',
				'repos.installResult': 'Install result',
				'repos.installedRow': '{name} · {state}',
				'repos.installedStateNew': 'installed',
				'repos.installedStateUpdated': 'updated',
				'repos.installedBackup': 'Backup: {path}',
				'repos.skippedRow': '{name} · skipped: {reason}',
				'repos.installDone': 'Processed {count} skills.',
				'repos.restore': 'Restore previous',
				'repos.restoreConfirm': 'Overwrite "{name}" with the backup from {time}? The current version is backed up again first.',
				'repos.restoreNone': '"{name}" has no backup to restore.',
				'repos.restored': 'Restored "{name}".',
				'repos.addTitle': 'Add repository',
				'repos.addUrl': 'Repository',
				'repos.addUrlPlaceholder': 'obra/superpowers or https://github.com/obra/superpowers',
				'repos.addRef': 'Ref / tag (optional)',
				'repos.addRefPlaceholder': 'default branch',
				'repos.addSubdir': 'Subdirectory (optional)',
				'repos.addSubdirPlaceholder': 'skills',
				'repos.add': 'Add repository',
				'repos.adding': 'Adding and fetching for the first time…',
				'repos.added': 'Subscribed to "{id}".',
				'repos.addFetchError': 'The subscription was added, but the first fetch failed: {error}',
				'repos.selectAll': 'Select installable',
				'repos.selectNone': 'Select none',
				'repos.selected': '{count} selected',
				'repos.installTarget': 'Install to',
				'repos.targetGlobal': 'Global skill root',
				'repos.targetProject': 'Current project skill root',
				'repos.targetProjectHint': 'Installing into the current project never writes the global skill root; an existing same-named project skill needs confirmation to overwrite.',
			},
		}

		/**
		 * 本地化函数：优先用 locale 服务（`ctx.locale.bind(NS)`，或 shell 注入的 `t`），
		 * 拿不到/翻译不出（返回 key 本身）就落回内置 zh 字典。
		 *
		 * 为什么要这层兜底：宿主没注册字典、locale 服务缺席、或验证桩里 bind 是恒等函数时，
		 * 界面不该显示成 `skills.scope.global` 这种 key。
		 */
		let localeT = null
		let localeBroken = false

		/** `{name}` 占位符插值（与官方 locale 服务的写法一致）。 */
		function interpolate(template, params) {
			if (!params) return template
			return String(template).replace(/\{(\w+)\}/g, (match, name) =>
				Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
			)
		}

		/** 模块级翻译（供非组件代码用它，比如 section label）。 */
		function t(key, params) {
			if (localeT !== null && !localeBroken) {
				try {
					const value = localeT(key, params)
					if (typeof value === 'string' && value !== key) return value
				} catch (error) {
					// 只降级一次并报一次：locale 面坏掉是异常情况，不该每帧刷日志。
					localeBroken = true
					console.warn('[dsh-skill-console] locale 翻译失败，改用内置字典：', error)
				}
			}
			const fallback = DICT.zh[key]
			return interpolate(fallback !== undefined ? fallback : key, params)
		}

		/**
		 * 组件用的翻译函数：shell 通过 `locale: NS` 注入的 `t` 优先（它知道当前语言），
		 * 但仍走上面同一套「翻译不出就回内置字典」的规则。
		 */
		function makeT(injected) {
			return (key, params) => {
				if (typeof injected === 'function') {
					try {
						const value = injected(key, params)
						if (typeof value === 'string' && value !== key) return value
					} catch (error) {
						console.warn('[dsh-skill-console] 注入的 t 调用失败，改用内置字典：', error)
					}
				}
				return t(key, params)
			}
		}

		// ── 样式（只用官方设计令牌，跟随明暗主题） ────────────────────────────────

		const CSS = `
.sc-section { display: flex; flex-direction: column; gap: 10px; height: calc(100vh - 190px); min-height: 420px; }
.sc-head { display: flex; flex-direction: column; gap: 4px; }
.sc-title { font-size: 14px; font-weight: 600; }
.sc-sub { font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-tertiary, rgba(127,127,127,0.9)); }
.sc-bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12px; }
.sc-tabs { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.sc-spacer { flex: 1 1 auto; }
.sc-nowrap { white-space: nowrap; }
.sc-body { display: flex; flex: 1 1 auto; flex-direction: column; gap: 10px; min-height: 0; overflow: auto; padding-right: 2px; }
/* 本面板的高度是定死的（.sc-section 给了确定高度），内容一超高，浏览器就会按 flex-shrink
   去压 .sc-body 的子项：而 overflow:hidden 的子项**自动最小尺寸是 0**，会被一路压成
   0 高度——订阅卡片就是这样整段消失的，界面上只剩它上下两条边框糊在下一张卡片的顶边上。
   所以子项一律不收缩，超出的部分交给 .sc-body 自己的 overflow:auto 滚动。 */
.sc-body > * { flex: 0 0 auto; }
.sc-group { border: 1px solid var(--dsw-alias-border-l3, rgba(127,127,127,0.3)); border-radius: 8px; overflow: hidden; }
/* 订阅卡片：一行仓库 + 可折叠的技能明细。整行头部都能点，展开状态由三角朝向表达。 */
.sc-repo { border: 1px solid var(--dsw-alias-border-l3, rgba(127,127,127,0.3)); border-radius: 8px; overflow: hidden; }
.sc-repo-head { display: flex; align-items: flex-start; gap: 10px; padding: 8px 10px; }
.sc-repo-head.is-clickable { cursor: pointer; }
.sc-repo-head.is-clickable:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.1)); }
.sc-repo.is-open > .sc-repo-head { border-bottom: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.18)); }
.sc-repo-body { display: flex; flex-direction: column; gap: 8px; padding: 10px; background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.04)); }
.sc-repo-body > * { flex: 0 0 auto; }
/* 订阅卡片列表：同样一律不收缩（理由见上面 .sc-body 那条）。 */
.sc-repos { display: flex; flex-direction: column; gap: 10px; }
.sc-repos > * { flex: 0 0 auto; }
.sc-disclosure { font: inherit; font-size: 12px; display: inline-flex; align-items: center; gap: 6px; flex: 0 0 auto; padding: 4px 8px; border: 1px solid var(--dsw-alias-border-l3, rgba(127,127,127,0.4)); border-radius: 6px; background: transparent; color: inherit; cursor: pointer; }
.sc-disclosure:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.14)); }
.sc-disclosure:disabled { opacity: 0.5; cursor: default; }
/* 折叠三角用 CSS 画：shell 有没有 chevron 图标都不影响可读性。 */
.sc-caret { width: 0; height: 0; border-top: 4px solid transparent; border-bottom: 4px solid transparent; border-left: 5px solid currentColor; transition: transform 0.12s ease; }
.sc-caret[data-open="true"] { transform: rotate(90deg); }
.sc-group-head { display: flex; align-items: center; gap: 8px; padding: 7px 10px; border-bottom: 1px solid var(--dsw-alias-border-l3, rgba(127,127,127,0.3)); background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.06)); font-size: 12px; }
.sc-group-title { font-weight: 600; }
.sc-row { display: flex; align-items: flex-start; gap: 10px; padding: 8px 10px; border-top: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.18)); }
.sc-group .sc-row:first-child { border-top: 0; }
.sc-row.is-clickable { cursor: pointer; }
.sc-row.is-clickable:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.1)); }
.sc-row-main { display: flex; flex: 1 1 auto; flex-direction: column; gap: 3px; min-width: 0; }
.sc-row-head { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.sc-row-actions { display: flex; flex: 0 0 auto; align-items: center; gap: 6px; }
.sc-name { font-size: 13px; font-weight: 600; }
.sc-desc { font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-secondary, rgba(127,127,127,1)); }
/* 技能明细行：显示所属仓库，简介改到悬停气泡里。 */
.sc-source { display: inline-flex; align-items: baseline; gap: 6px; min-width: 0; font-size: 12px; line-height: 1.6; }
.sc-source-label { flex: 0 0 auto; color: var(--dsw-alias-label-tertiary, rgba(127,127,127,0.9)); }
.sc-source-value { min-width: 0; font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace); color: var(--dsw-alias-label-secondary, rgba(127,127,127,1)); word-break: break-all; }
.sc-tip-body { display: flex; flex-direction: column; gap: 5px; }
.sc-tip-desc { white-space: pre-wrap; }
.sc-tip-meta { font-size: 11px; opacity: 0.72; }
.sc-tags { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.sc-meta { font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 11.5px; color: var(--dsw-alias-label-tertiary, rgba(127,127,127,0.9)); word-break: break-all; }
.sc-hint { font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-tertiary, rgba(127,127,127,0.9)); }
.sc-warn { display: flex; align-items: flex-start; gap: 6px; font-size: 12px; line-height: 1.6; color: var(--dsw-alias-state-warn-label, #b7791f); word-break: break-word; }
.sc-err { font-size: 12px; line-height: 1.6; color: var(--dsw-alias-state-error-primary, #d1242f); word-break: break-word; }
.sc-ok { font-size: 12px; line-height: 1.6; color: var(--dsw-alias-state-success-primary, #2ea043); }
.sc-note { border: 1px solid var(--dsw-alias-border-l3, rgba(127,127,127,0.3)); border-left: 3px solid var(--dsw-alias-state-warn-primary, #d29922); border-radius: 6px; padding: 8px 10px; font-size: 12px; line-height: 1.7; background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.05)); }
.sc-card { display: flex; flex-direction: column; gap: 8px; border: 1px solid var(--dsw-alias-border-l3, rgba(127,127,127,0.3)); border-radius: 8px; padding: 10px 12px; }
.sc-empty { padding: 14px; border: 1px dashed var(--dsw-alias-border-l3, rgba(127,127,127,0.4)); border-radius: 8px; font-size: 12px; line-height: 1.7; color: var(--dsw-alias-label-tertiary, rgba(127,127,127,0.9)); }
.sc-pre { margin: 0; padding: 10px; max-height: 240px; overflow: auto; border: 1px solid var(--dsw-alias-border-l3, rgba(127,127,127,0.28)); border-radius: 6px; background: var(--dsw-alias-markdown-code-block, rgba(127,127,127,0.08)); font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 11.5px; line-height: 1.6; white-space: pre-wrap; word-break: break-word; }
.sc-select { font: inherit; font-size: 12px; max-width: 340px; padding: 3px 6px; border: 1px solid var(--dsw-alias-border-l3, rgba(127,127,127,0.4)); border-radius: 6px; background: transparent; color: inherit; }
.sc-form { display: flex; align-items: flex-end; gap: 10px; flex-wrap: wrap; }
/* 订阅的编辑表单：跟着它所属的那一行，所以用虚线分隔而不是换一个卡片。 */
.sc-edit { display: flex; flex-direction: column; gap: 8px; padding: 10px; border-top: 1px dashed var(--dsw-alias-border-l3, rgba(127,127,127,0.4)); background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.06)); }
.sc-field { display: flex; flex-direction: column; gap: 4px; min-width: 160px; }
.sc-field-label { font-size: 11.5px; color: var(--dsw-alias-label-tertiary, rgba(127,127,127,0.9)); }
.sc-field-wide { min-width: 300px; flex: 1 1 300px; }
.sc-btn { font: inherit; font-size: 12px; display: inline-flex; align-items: center; gap: 4px; padding: 4px 10px; border: 1px solid var(--dsw-alias-border-l3, rgba(127,127,127,0.4)); border-radius: 6px; background: transparent; color: inherit; cursor: pointer; }
.sc-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.14)); }
.sc-btn:disabled { opacity: 0.5; cursor: default; }
.sc-btn-primary { border-color: var(--dsw-alias-brand-primary, #4a7dff); background: var(--dsw-alias-interactive-bg-hover, rgba(74,125,255,0.12)); }
.sc-btn-danger { border-color: var(--dsw-alias-state-error-primary, #d1242f); }
.sc-pill { font: inherit; font-size: 12px; padding: 3px 10px; border: 1px solid var(--dsw-alias-border-l3, rgba(127,127,127,0.4)); border-radius: 999px; background: transparent; color: inherit; cursor: pointer; }
.sc-pill[data-active="true"] { border-color: var(--dsw-alias-brand-primary, #4a7dff); background: var(--dsw-alias-interactive-bg-hover, rgba(74,125,255,0.14)); font-weight: 600; }
.sc-tag { display: inline-flex; align-items: center; font-size: 11px; padding: 1px 6px; border: 1px solid var(--dsw-alias-border-l3, rgba(127,127,127,0.4)); border-radius: 4px; white-space: nowrap; }
.sc-tag[data-tone="success"] { color: var(--dsw-alias-state-success-primary, #2ea043); border-color: var(--dsw-alias-state-success-primary, #2ea043); }
.sc-tag[data-tone="warning"] { color: var(--dsw-alias-state-warn-label, #b7791f); border-color: var(--dsw-alias-state-warn-primary, #d29922); }
.sc-tag[data-tone="danger"] { color: var(--dsw-alias-state-error-primary, #d1242f); border-color: var(--dsw-alias-state-error-primary, #d1242f); }
.sc-tag[data-tone="info"] { color: var(--dsw-alias-state-business-primary, #4a7dff); border-color: var(--dsw-alias-state-business-primary, #4a7dff); }
.sc-tag[data-tone="quiet"] { color: var(--dsw-alias-label-tertiary, rgba(127,127,127,0.9)); }
.sc-tip { display: inline-flex; align-items: center; }
.sc-link { color: var(--dsw-alias-link, inherit); text-decoration: none; }
.sc-link:hover { text-decoration: underline; }
.sc-changed { display: flex; flex-wrap: wrap; gap: 4px; }
.sc-change { font-family: var(--ds-font-family-code, ui-monospace, Menlo, monospace); font-size: 10.5px; padding: 0 4px; border-radius: 4px; border: 1px solid var(--dsw-alias-border-l3, rgba(127,127,127,0.35)); }
.sc-change[data-change="added"] { color: var(--dsw-alias-state-success-primary, #2ea043); }
.sc-change[data-change="removed"] { color: var(--dsw-alias-state-error-primary, #d1242f); }
.sc-change[data-change="modified"] { color: var(--dsw-alias-state-warn-label, #b7791f); }
.sc-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--dsw-alias-label-tertiary, rgba(127,127,127,0.7)); }
.sc-dot[data-state="done"] { background: var(--dsw-alias-state-success-primary, #2ea043); }
.sc-dot[data-state="error"] { background: var(--dsw-alias-state-error-primary, #d1242f); }
.sc-stack { display: flex; flex-direction: column; gap: 6px; }
.sc-inline { display: inline-flex; align-items: center; gap: 6px; }
.sc-role-row { align-items: center; }
.sc-role-main { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; min-width: 0; }
.sc-role-name { font-weight: 600; }
.sc-role-editor { display: flex; flex-direction: column; gap: 10px; }
.sc-role-editor-head { display: flex; align-items: center; gap: 8px; }
.sc-role-skills { display: flex; flex-direction: column; }
.sc-role-skill { display: flex; align-items: center; gap: 8px; padding: 6px 10px; border-top: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.18)); }
.sc-role-skill-name { font-family: var(--dsw-font-mono, monospace); font-size: 12px; }
.sc-role-skill-readonly { opacity: 0.6; }
.sc-role-global-note { padding: 6px 10px; font-size: 12px; color: var(--dsw-alias-label-tertiary, rgba(127,127,127,0.9)); }
.sc-role-missing { display: flex; flex-direction: column; gap: 4px; padding: 8px 10px; }
.sc-role-missing-title { font-weight: 600; font-size: 12px; }
.sc-role-missing-list { display: flex; gap: 6px; flex-wrap: wrap; }
.sc-role-error { color: var(--dsw-alias-label-error, #d33); font-size: 12px; }
.sc-role-notice { font-size: 12px; color: var(--dsw-alias-label-tertiary, rgba(127,127,127,0.9)); }
`

		// ── 就地降级边界 ──────────────────────────────────────────────────────

		/**
		 * 外部插件绝不能让宿主界面陪葬：渲染抛错（数据形状变了、primitives 行为变了、
		 * 我自己写错）时 React 只把**这一块**降级成空。这也是官方对客户端插件的硬要求。
		 */
		class PanelBoundary extends react.Component {
			constructor(props) {
				super(props)
				this.state = { failed: false }
			}
			static getDerivedStateFromError() {
				return { failed: true }
			}
			componentDidCatch(error) {
				console.error('[dsh-skill-console] 渲染失败，已就地降级为空：', error)
			}
			render() {
				return this.state.failed ? null : this.props.children
			}
		}

		// ── 最小状态存储 ──────────────────────────────────────────────────────

		/** 一份最小订阅存储。 */
		function createStore(initial) {
			let value = initial
			const listeners = new Set()
			return {
				get: () => value,
				set: (next) => {
					value = next
					for (const listener of listeners) listener(value)
				},
				subscribe: (listener) => {
					listeners.add(listener)
					return () => listeners.delete(listener)
				},
			}
		}

		/** 在组件里订阅一份 store。 */
		function useStore(store) {
			const [value, setValue] = react.useState(store.get())
			react.useEffect(() => store.subscribe(setValue), [store])
			return value
		}

		/**
		 * 「技能目录需要重读」的信号。仓库标签页安装/恢复成功后 +1，
		 * 技能标签页订阅它并在变化时重新拉 /catalog——这就是「装完之后两个页签都刷新」，
		 * 又不需要把两棵组件树缝在一起。
		 */
		const catalogRevisionStore = createStore(0)
		function bumpCatalog() {
			catalogRevisionStore.set(catalogRevisionStore.get() + 1)
		}

		// ── 组件降级包装（有 primitives 用产品件，没有就原生元素） ────────────────

		function UiButton(props) {
			const Button = primitive('Button')
			if (Button) return h(Button, props)
			const { variant, size, icon, className, children, ...rest } = props
			const variantClass = variant === 'primary' ? ' sc-btn-primary' : variant === 'danger' ? ' sc-btn-danger' : ''
			return h(
				'button',
				{ type: 'button', ...rest, className: 'sc-btn' + variantClass + (className ? ' ' + className : '') },
				icon ? h('span', { className: 'sc-tip' }, icon) : null,
				children,
			)
		}

		function UiPill(props) {
			const Pill = primitive('Pill')
			if (Pill) return h(Pill, props)
			const { active, className, children, ...rest } = props
			return h('button', { type: 'button', ...rest, 'data-active': active ? 'true' : 'false', className: 'sc-pill' + (className ? ' ' + className : '') }, children)
		}

		function UiTag(props) {
			const Tag = primitive('Tag')
			if (Tag) return h(Tag, props)
			const { tone, className, children } = props
			return h('span', { 'data-tone': tone || 'outline', className: 'sc-tag' + (className ? ' ' + className : '') }, children)
		}

		function UiSwitch(props) {
			const Switch = primitive('Switch')
			if (Switch) return h(Switch, props)
			// 降级成一个语义等价的复选框：aria 名字、禁用、悬停说明都保留。
			return h('input', {
				type: 'checkbox',
				checked: props.checked === true,
				disabled: props.disabled === true,
				title: props.title,
				'aria-label': props.label,
				onChange: (event) => props.onChange(event.target.checked),
			})
		}

		function UiInput(props) {
			const Input = primitive('Input')
			if (Input) return h(Input, props)
			const { icon, className, ...rest } = props
			return h('input', { ...rest, className: 'sc-select' + (className ? ' ' + className : '') })
		}

		/**
		 * Tooltip 降级：primitives 的 Tooltip 会克隆唯一子元素挂浮泡；没有它时
		 * 退化成原生 `title`（说明文字仍然能被读到，只是没有那么好看）。
		 */
		function UiTooltip(props) {
			const Tooltip = primitive('Tooltip')
			if (Tooltip) return h(Tooltip, props)
			return h('span', { className: 'sc-tip', title: typeof props.label === 'string' ? props.label : undefined }, props.children)
		}

		function UiStateDot(props) {
			const StateDot = primitive('StateDot')
			if (StateDot) return h(StateDot, props)
			return h('span', { className: 'sc-dot', 'data-state': props.state, 'aria-hidden': 'true' })
		}

		/** 有图标就用产品图标，没有就不渲染（文字信息本身已经完整）。 */
		function UiIcon(name, size) {
			const Icon = primitive(name)
			return Icon ? h(Icon, { size: size || 14 }) : null
		}

		// ── HTTP ─────────────────────────────────────────────────────────────

		/** 把 `{ok:false, code, error}` 变成带 code 的 Error，供 UI 分码处理。 */
		function apiError(body, status, notJson) {
			const code = body && typeof body.code === 'string' ? body.code : null
			const text = body && typeof body.error === 'string' ? body.error : 'HTTP ' + status
			const error = new Error(text)
			error.code = code
			error.status = status
			// 裸文本响应（`unauthorized` / `not found` 之类）说明请求**没走到本插件的路由**：
			// 本插件的每个响应都是 JSON 壳，永远会带 code。这时要说清「后端没挂上」，
			// 而不是让用户对着一句 `HTTP 401` 猜。
			error.notMounted = notJson === true && (status === 401 || status === 403 || status === 404)
			return error
		}

		/**
		 * 唯一的请求出口。
		 *
		 * 一律带会话头（拿得到就带）：宿主用它把「项目」解析成该会话的 cwd。
		 * 不带也能用——宿主回落到它自己的默认项目，并在 data.project.fallback 里说明。
		 */
		async function request(path, options) {
			const { session, ...rest } = options || {}
			const headers = { ...(rest.headers || {}) }
			if (typeof session === 'string' && session !== '') headers[SESSION_HEADER] = session
			const response = await fetch(API + path, { cache: 'no-store', ...rest, headers })
			const body = await response.json().catch(() => null)
			if (!response.ok || !body || body.ok !== true) throw apiError(body, response.status, body === null)
			return body.data
		}

		/** GET：参数里 undefined / '' 一律不拼进 query。 */
		function apiGet(path, params, session) {
			const search = new URLSearchParams()
			if (params) {
				for (const [key, value] of Object.entries(params)) {
					if (value === undefined || value === null || value === '') continue
					search.set(key, String(value))
				}
			}
			const query = search.toString()
			return request(path + (query === '' ? '' : '?' + query), { method: 'GET', session })
		}

		/**
		 * POST：`content-type: application/json` + `x-skill-console: 1` 两个头缺一不可
		 * （宿主靠自定义头 + JSON content-type 做跨站围栏），所以写操作只有这一个入口。
		 */
		function apiPost(path, body, session) {
			return request(path, { method: 'POST', headers: { ...WRITE_HEADERS }, body: JSON.stringify(body || {}), session })
		}

		/**
		 * 错误码 → 本地化文案的映射表。命中就用前端文案（宿主文案只有中文，
		 * 英文界面下不该冒出中文），未命中直接展示服务端 `error` 文本。
		 */
		const ERROR_KEYS = {
			'error.path.outsideRoots': 'error.pathOutsideRoots',
			'error.toggle.conflict': 'error.toggleConflict',
			'error.toggle.symlink': 'error.toggleSymlink',
			'error.internal': 'error.internal',
			'error.repo.rateLimit': 'error.rateLimit',
			'error.repo.network': 'error.network',
			'error.repo.subdirectory': 'error.repoSubdirectory',
			// 宿主原文里带状态文件的绝对路径，所以这一条必须翻译（面板不显示目录地址）。
			'error.repo.state': 'error.repoState',
			'error.backup.notFound': 'error.backupNotFound',
		}

		/** 把任何异常变成本地化的一行话。 */
		function errorMessage(t, error) {
			const code = error && typeof error.code === 'string' ? error.code : null
			if (code === null && error && error.notMounted === true) return t('error.endpointMissing', { status: String(error.status) })
			if (code !== null && ERROR_KEYS[code] !== undefined) return t(ERROR_KEYS[code])
			const text = error && error.message ? String(error.message) : String(error)
			return text
		}

		/** 操作失败时统一加前缀，避免界面上出现一句没有上下文的报错。 */
		function actionError(t, error) {
			return t('error.action', { error: errorMessage(t, error) })
		}

		// ── 数据整形 / 小工具 ──────────────────────────────────────────────────

		/**
		 * 诊断项在契约里写作 `{code, message}`，但宿主扫描路径上也可能给出裸 code 字符串
		 * （例如 `'error.file.read'`）。两种都收下，统一成 `{code, message}`。
		 */
		function normalizeDiagnostics(list) {
			if (!Array.isArray(list)) return []
			const out = []
			for (const entry of list) {
				if (typeof entry === 'string') {
					out.push({ code: entry, message: null })
				} else if (entry && typeof entry === 'object' && typeof entry.code === 'string') {
					out.push({ code: entry.code, message: typeof entry.message === 'string' ? entry.message : null })
				} else if (entry !== null && entry !== undefined) {
					out.push({ code: 'diagnostic.unknown', message: String(entry) })
				}
			}
			return out
		}

		/** 诊断/错误码 → 文案：先按码翻译，翻不出就用宿主的人话，再翻不出就显示码。 */
		function codeText(t, code, message) {
			const translated = t(code)
			if (typeof translated === 'string' && translated !== code) return translated
			return message || code
		}

		/** 不可启停的原因（软链接是唯一已知原因；其他一律展示宿主给的原话）。 */
		function readOnlyText(t, skill) {
			if (skill.toggleable !== false) return null
			if (skill.readOnlyReason === 'symlink' || skill.readOnlyReason === null || skill.readOnlyReason === undefined) {
				return t('skills.readOnlySymlink')
			}
			return t('skills.readOnlyOther', { reason: String(skill.readOnlyReason) })
		}

		/** 技能形态：软链接 > 扁平 > 目录包（与宿主 `planRemoval` 的 form 同一口径）。 */
		function skillFormOf(skill) {
			if (!skill || skill.toggleable !== true) return 'symlink'
			return skill.kind === 'flat' ? 'flat' : 'directory'
		}

		function skillFormText(t, skill) {
			const form = skillFormOf(skill)
			if (form === 'symlink') return t('skills.formSymlink')
			return form === 'flat' ? t('skills.formFlat') : t('skills.formDirectory')
		}

		/** 删除确认框：根名 + 技能名 + 形态；软链接与全局各补一句后果。 */
		function deleteConfirmText(t, skill, rootName) {
			const lines = [t('skills.deleteConfirm', { name: (skill && skill.name) || '', form: skillFormText(t, skill), root: rootName || '' })]
			if (skillFormOf(skill) === 'symlink') lines.push(t('skills.deleteSymlinkHint'))
			if (skill && skill.root === 'user-dsh') lines.push(t('skills.deleteGlobalHint'))
			return lines.join('\n')
		}

		/** 移动确认框：只有全局技能才该被问到。 */
		function moveConfirmText(t, skill, projectName) {
			return t('skills.moveConfirm', { name: (skill && skill.name) || '', project: projectName || '' })
		}

		/** 服务器给的根 key → 显示名：优先用宿主 label，没有就用本地化根名。 */
		function rootLabel(t, key, fallbackLabel) {
			if (typeof fallbackLabel === 'string' && fallbackLabel !== '') return fallbackLabel
			if (typeof key === 'string' && key !== '') return t('roots.' + key)
			return t('diagnostic.unknown')
		}

		/** primitives 的 relativeTime 只给桶（`{unit, n}`），词由各自的字典负责。 */
		function relativeText(t, at) {
			if (typeof at !== 'number' || !Number.isFinite(at)) return t('time.unknown')
			const relativeTime = primitive('relativeTime')
			if (relativeTime) {
				try {
					const bucket = relativeTime(at, Date.now())
					if (bucket && typeof bucket.unit === 'string') return t('time.' + bucket.unit, { n: bucket.n })
				} catch (error) {
					console.warn('[dsh-skill-console] relativeTime 调用失败，改用内置口径：', error)
				}
			}
			// 降级口径与 primitives 保持一致（否则同屏两处时间会对不上）。
			const MIN = 60000
			const HOUR = 3600000
			const DAY = 86400000
			const diff = Math.max(0, Date.now() - at)
			if (diff < MIN) return t('time.now')
			if (diff < HOUR) return t('time.minutes', { n: Math.floor(diff / MIN) })
			if (diff < DAY) return t('time.hours', { n: Math.floor(diff / HOUR) })
			if (diff < 30 * DAY) return t('time.days', { n: Math.floor(diff / DAY) })
			if (diff < 365 * DAY) return t('time.months', { n: Math.floor(diff / (30 * DAY)) })
			return t('time.years', { n: Math.floor(diff / (365 * DAY)) })
		}

		/** 字节数（primitives 缺失时的等价实现）。 */
		function bytesText(bytes) {
			const fileSizeText = primitive('fileSizeText')
			if (fileSizeText && typeof bytes === 'number') {
				try {
					return fileSizeText(bytes)
				} catch (error) {
					console.warn('[dsh-skill-console] fileSizeText 调用失败：', error)
				}
			}
			if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return '—'
			if (bytes < 1024) return bytes + 'B'
			const kb = bytes / 1024
			if (kb < 1024) return (kb < 10 ? kb.toFixed(1) : String(Math.round(kb))) + 'KB'
			const mb = kb / 1024
			if (mb < 1024) return (mb < 10 ? mb.toFixed(1) : String(Math.round(mb))) + 'MB'
			return (mb / 1024).toFixed(1) + 'GB'
		}

		/** 只允许 http(s) 链接成为可点的 href（订阅元数据不该能注入别的协议）。 */
		function safeHref(url) {
			return typeof url === 'string' && /^https?:\/\//i.test(url) ? url : null
		}

		/**
		 * 路径的末段（`/a/b/c` → `c`）。
		 *
		 * 面板上不显示任何具体目录地址，但「这是哪一个」仍然要讲清楚——所以凡是
		 * 需要指代某个目录/文件的地方，一律退到末段名，而不是绝对路径。
		 */
		function baseName(value) {
			if (typeof value !== 'string' || value === '') return ''
			const parts = value.split(/[\\/]+/).filter((part) => part !== '')
			return parts.length > 0 ? parts[parts.length - 1] : value
		}

		/** 项目在界面上的显示名：只有末段目录名，拿不到就用一个中性占位符。 */
		function projectNameOf(project) {
			const name = baseName(project && (project.root || project.cwd))
			return name === '' ? '—' : name
		}

		/**
		 * 把用户选过的项目映射回**当前**的选项列表：先认会话 id，再认项目根。
		 *
		 * 宿主已把同一项目的多个会话收敛成一条，代表会话会随时间换人（同项目别的会话变新），
		 * 所以只认 id 会让下拉框选空。两个都认不到（项目整个从列表里消失）返回 `null`，
		 * 由调用方落回默认项目——而不是把界面停在一个选不中的值上。
		 *
		 * @param pick - 用户选过的 `{value, root}`，或 `null`。
		 * @param options - `projectOptionsOf()` 的结果。
		 * @returns 命中的选项，或 `null`。
		 */
		function projectOptionOfPick(pick, options) {
			if (pick === null || pick === undefined) return null
			const list = Array.isArray(options) ? options : []
			return list.find((option) => option.value === pick.value) ?? list.find((option) => option.root === pick.root) ?? null
		}

		/**
		 * 项目下拉框的选项。
		 *
		 * 值必须是**会话 id**：宿主靠它把请求解析成该会话的 `cwd`（进而项目根）。
		 * 标签只给项目名——面板从头到尾不显示绝对路径，一排一模一样的地址更是没法选。
		 * 去重由宿主做（`/state.projects` 已按项目根收敛），这里不再重复判重。
		 *
		 * @param projects - `/state` 的 `projects`。
		 * @returns `[{value, label, root}]`；`root` 只在客户端用来「认领」用户选过的项目。
		 */
		function projectOptionsOf(projects) {
			const list = Array.isArray(projects) ? projects : []
			return list.map((entry) => ({
				value: String(entry?.sessionId ?? ''),
				label: projectNameOf(entry),
				root: typeof entry?.root === 'string' ? entry.root : String(entry?.cwd ?? ''),
			}))
		}

		/** 停止冒泡：行本身可点开详情，行内控件必须先掐断。 */
		function stop(fn) {
			return (event) => {
				if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
				if (typeof fn === 'function') fn(event)
			}
		}

		/** 只有浏览器里有 confirm；缺席时按「取消」处理（宁可不动，也不悄悄写盘）。 */
		function askConfirm(message) {
			if (typeof window === 'undefined' || typeof window.confirm !== 'function') return false
			return window.confirm(message) === true
		}

		// ── 技能标签页 ────────────────────────────────────────────────────────

		/**
		 * 技能明细行要显示的「所属仓库」。
		 *
		 * 订阅安装的给 `owner/name`（明细行显示这个，简介挪到悬停气泡）；
		 * 本地技能给 `null`，由调用方回落到 `t('skills.sourceLocal')`。
		 * 拿不到 owner/name 时退回仓库 id（它本身就是 `owner/name[/子目录]`），再不行就是 null。
		 *
		 * @param skill - `/catalog` 的一行。
		 * @returns 展示用的仓库名，或 null。
		 */
		function sourceRepoOf(skill) {
			const installed = skill && typeof skill.installed === 'object' && skill.installed !== null ? skill.installed : null
			if (installed === null) return null
			const owner = typeof installed.owner === 'string' && installed.owner !== '' ? installed.owner : null
			const name = typeof installed.name === 'string' && installed.name !== '' ? installed.name : null
			if (owner !== null && name !== null) return owner + '/' + name
			return typeof installed.id === 'string' && installed.id !== '' ? installed.id : null
		}

		/** 一个技能行。可点开详情；启停只走 /toggle，绝不为软链接发请求。 */
		function SkillRow(props) {
			const t = props.t
			const skill = props.skill || {}
			const diagnostics = normalizeDiagnostics(skill.diagnostics)
			const installed = skill.installed && typeof skill.installed === 'object' ? skill.installed : null
			const readOnly = readOnlyText(t, skill)
			const statusKey = diagnostics.length > 0 ? 'skills.status.invalid' : skill.enabled ? 'skills.status.enabled' : 'skills.status.disabled'
			const statusTone = diagnostics.length > 0 ? 'warning' : skill.enabled ? 'success' : 'quiet'
			const statusTag = h(UiTag, { tone: statusTone }, t(statusKey))

			/**
			 * 简介只在气泡可见时才构造（`Tooltip.label` 支持「仅当气泡可见时求值」的解析函数）。
			 * 明细行本身显示**所属仓库**：订阅装的显示 owner/name，本地技能显示「本地（非订阅）」。
			 */
			const descriptionTip = () =>
				h(
					'div',
					{ className: 'sc-tip-body' },
					h('div', { className: 'sc-tip-desc' }, skill.description || t('skills.noDescription')),
					installed
						? h(
								'div',
								{ className: 'sc-tip-meta' },
								t('skills.installedTitle', { id: installed.id, commit: installed.commit || '—' }),
								installed.sourcePath ? ' · ' + installed.sourcePath : '',
							)
						: null,
				)

			const sourceLine = h(
				UiTooltip,
				{ label: descriptionTip, side: 'top', delayMs: 120, maxWidth: 380 },
				h(
					'span',
					{ className: 'sc-source' },
					h('span', { className: 'sc-source-label' }, t('skills.source')),
					h('span', { className: 'sc-source-value' }, sourceRepoOf(skill) ?? t('skills.sourceLocal')),
				),
			)

			return h(
				'div',
				{
					className: 'sc-row is-clickable',
					onClick: () => props.onOpen(skill),
					role: 'button',
					tabIndex: 0,
					onKeyDown: (event) => {
						if (event.key === 'Enter' || event.key === ' ') {
							event.preventDefault()
							props.onOpen(skill)
						}
					},
				},
				h(
					'div',
					{ className: 'sc-row-main' },
					h(
						'div',
						{ className: 'sc-row-head' },
						h('span', { className: 'sc-name' }, skill.name || '—'),
						skill.declaredName === null || skill.declaredName === undefined
							? h('span', { className: 'sc-hint', title: t('skills.nameFromDirectory') }, 'ⓘ')
							: null,
						statusTag,
					),
					sourceLine,
					diagnostics.map((entry, index) =>
						h(
							'div',
							{ className: 'sc-warn', key: 'diag-' + index },
							UiIcon('IconWarningOutline16', 13),
							h('span', null, h('code', { className: 'sc-meta' }, entry.code), ' ', codeText(t, entry.code, entry.message)),
						),
					),
				),
				h(
					'div',
					{ className: 'sc-row-actions', onClick: stop() },
					props.onDelete
						? h(UiButton, {
								variant: 'ghost',
								size: 'sm',
								onClick: () => props.onDelete(skill, props.rootName),
								children: t('skills.delete'),
							})
						: null,
					props.canMove === true && props.onMove
						? h(UiButton, {
								variant: 'ghost',
								size: 'sm',
								onClick: () => props.onMove(skill, props.rootName),
								children: t('skills.move'),
							})
						: null,
					h(UiButton, {
						variant: 'ghost',
						size: 'sm',
						onClick: () => props.onOpen(skill),
						children: t('common.detail'),
					}),
					h(UiTooltip, {
						label: readOnly || t('skills.toggle') + ' ' + (skill.name || ''),
						side: 'top',
						children: h(UiSwitch, {
							checked: skill.enabled === true,
							disabled: props.busy || readOnly !== null,
							label: t('skills.toggleAria', { name: skill.name || '' }),
							title: readOnly || undefined,
							onChange: (next) => props.onToggle(skill, next),
						}),
					}),
				),
			)
		}

		/** 一个技能根（分组）：标题 + 根路径 + 组内批量启停 + 行列表。 */
		function SkillGroup(props) {
			const t = props.t
			const root = props.root || {}
			const skills = Array.isArray(root.skills) ? root.skills : []
			const existing = skills.filter((skill) => skill.toggleable !== false)
			const canEnable = existing.some((skill) => skill.enabled !== true)
			const canDisable = existing.some((skill) => skill.enabled === true)
			return h(
				'div',
				{ className: 'sc-group' },
				h(
					'div',
					{ className: 'sc-group-head' },
					h(UiStateDot, { state: root.exists === false ? 'error' : 'done', size: 8 }),
					h('span', { className: 'sc-group-title' }, rootLabel(t, root.key, root.label)),
					root.exists === false ? h(UiTag, { tone: 'warning' }, t('skills.groupMissing')) : null,
					h('span', { className: 'sc-spacer' }),
					h('span', { className: 'sc-hint' }, t('skills.groupCount', { count: skills.length })),
					h(UiButton, {
						variant: 'ghost',
						size: 'sm',
						disabled: props.busy || !canEnable,
						onClick: () => props.onBatch(root, true),
						children: t('skills.batchEnable'),
					}),
					h(UiButton, {
						variant: 'ghost',
						size: 'sm',
						disabled: props.busy || !canDisable,
						onClick: () => props.onBatch(root, false),
						children: t('skills.batchDisable'),
					}),
				),
				skills.length === 0
					? h('div', { className: 'sc-empty' }, t('skills.empty'))
					: skills.map((skill) =>
							h(SkillRow, {
								key: (root.key || '') + ':' + (skill.path || skill.name || ''),
								t,
								skill,
								busy: props.busyPath === skill.path,
								// 只有全局根里的普通技能能被搬到项目（软链接不碰）
								canMove: root.key === 'user-dsh' && skill.toggleable === true,
								rootName: rootLabel(t, root.key, root.label),
								onDelete: props.onDelete,
								onMove: props.onMove,
								onOpen: props.onOpen,
								onToggle: props.onToggle,
							}),
						),
			)
		}

		/** 技能详情（分区内的面板，不用 Modal：不抢焦点、不遮住目录，方便左右对照）。 */
		function SkillDetail(props) {
			const t = props.t
			const state = props.state || {}
			const data = state.data
			// labels 必须是引用稳定的对象，否则 MarkdownText 的渲染缓存每帧作废。
			const copyLabel = t('md.copy')
			const copiedLabel = t('md.copied')
			const footnotes = t('md.footnotes')
			const mdLabels = react.useMemo(() => ({ code: { copyLabel, copiedLabel }, footnotes }), [copyLabel, copiedLabel, footnotes])
			const MarkdownText = primitive('MarkdownText')

			const head = h(
				'div',
				{ className: 'sc-bar' },
				h('span', { className: 'sc-title' }, t('skills.detailTitle')),
				// 面板上不出现任何具体目录地址：这里用技能名标识这份详情（路径只留在宿主响应里）。
				data && data.name ? h('span', { className: 'sc-name' }, data.name) : null,
				data ? h(UiTag, { tone: data.enabled ? 'success' : 'quiet' }, t(data.enabled ? 'skills.status.enabled' : 'skills.status.disabled')) : null,
				h('span', { className: 'sc-spacer' }),
				h(UiButton, { variant: 'ghost', size: 'sm', onClick: props.onClose, children: t('common.close') }),
			)

			let body
			if (state.loading) {
				body = h('div', { className: 'sc-hint' }, t('skills.detailLoading'))
			} else if (state.error) {
				body = h('div', { className: 'sc-err' }, state.error)
			} else if (!data) {
				body = h('div', { className: 'sc-hint' }, t('skills.detailLoading'))
			} else {
				body = h(
					'div',
					{ className: 'sc-stack' },
					h('span', { className: 'sc-hint' }, t('skills.detailFrontmatter')),
					h('pre', { className: 'sc-pre' }, data.frontmatter || ''),
					h('span', { className: 'sc-hint' }, t('skills.detailBody')),
					data.body
						? MarkdownText
							? h(MarkdownText, { text: data.body, labels: mdLabels })
							: h('pre', { className: 'sc-pre' }, data.body)
						: h('div', { className: 'sc-hint' }, t('skills.detailNoBody')),
				)
			}
			return h('div', { className: 'sc-card' }, head, body)
		}

		/** 技能标签页：范围切换 + 项目选择 + 目录 + 详情。 */
		function SkillsPanel(props) {
			const t = props.t
			const sessionId = props.sessionId
			const [scope, setScope] = react.useState('global')
			// 用户选过的项目：存 `{value, root}` 而不是一个会话 id——见 projectOptionOfPick。
			const [projectPick, setProjectPick] = react.useState(null)
			const [env, setEnv] = react.useState({ loading: true, data: null, error: null })
			const [catalog, setCatalog] = react.useState({ loading: true, data: null, error: null })
			const [detail, setDetail] = react.useState(null)
			const [notice, setNotice] = react.useState(null)
			const [actionFail, setActionFail] = react.useState(null)
			const [busyPath, setBusyPath] = react.useState(null)
			const [batchBusy, setBatchBusy] = react.useState(false)
			const revision = useStore(catalogRevisionStore)
			// 快速切换范围时旧响应可能后到：用递增令牌丢弃过期结果，避免目录闪回上一个 scope。
			// /state 与 /catalog 各用一个令牌——共用一个的话，挂载时后发的 /catalog 会让
			// 先发的 /state 结果被当成过期丢掉（项目列表与「未取到会话」提示就再也不会出现）。
			const envToken = react.useRef(0)
			const catalogToken = react.useRef(0)

			const projects = env.data && Array.isArray(env.data.projects) ? env.data.projects : []
			const selectedSession = env.data && env.data.selected && typeof env.data.selected.sessionId === 'string' ? env.data.selected.sessionId : ''
			const projectOptions = projectOptionsOf(projects)
			/**
			 * 用户选过的项目按**项目根**认领，不是按会话 id：宿主已把同一项目的多个会话收敛成
			 * 一条，代表会话会随时间换人（同项目别的会话变新），只认 id 会让下拉框选空。
			 * 项目整个没了（会话都被回收）就落回默认，而不是把界面留在一个选不中的值上。
			 */
			const pickedOption = projectOptionOfPick(projectPick, projectOptions)
			// 默认用当前会话；用户选过且那个项目还在列表里就听用户的。
			const activeProject = pickedOption !== null ? pickedOption.value : sessionId || selectedSession

			/**
			 * 依赖里只放真正会变的值：`t` 和这两个加载函数每次渲染都是新引用，
			 * 放进依赖会变成无限重拉。effect 拿到的闭包属于它那一帧，语义正确。
			 */
			react.useEffect(() => {
				let alive = true
				const run = ++envToken.current
				setEnv((previous) => ({ loading: true, data: previous.data, error: null }))
				apiGet('/state', null, sessionId)
					.then((data) => {
						if (!alive || envToken.current !== run) return
						setEnv({ loading: false, data, error: null })
					})
					.catch((error) => {
						if (!alive || envToken.current !== run) return
						setEnv({ loading: false, data: null, error: errorMessage(t, error) })
					})
				return () => {
					alive = false
				}
			}, [sessionId, revision])

			const loadCatalog = () => {
				const run = ++catalogToken.current
				setCatalog((previous) => ({ loading: true, data: previous.data, error: null }))
				return apiGet('/catalog', { scope, project: scope === 'project' ? activeProject : undefined }, sessionId)
					.then((data) => {
						if (catalogToken.current !== run) return
						setCatalog({ loading: false, data, error: null })
					})
					.catch((error) => {
						if (catalogToken.current !== run) return
						setCatalog((previous) => ({ loading: false, data: previous.data, error: errorMessage(t, error) }))
					})
			}

			react.useEffect(() => {
				loadCatalog()
				// eslint-disable-next-line react-hooks/exhaustive-deps -- 见上面的注释：只依赖会变的值。
			}, [scope, activeProject, sessionId, revision])

			// 切范围/切项目时把上一轮的结果提示收起来（但**不能**在重拉目录时清，
			// 否则启停成功后刚显示的 takeover 提示会被紧随其后的刷新抹掉）。
			react.useEffect(() => {
				setNotice(null)
				setActionFail(null)
			}, [scope, activeProject])

			const loadDetail = (skill) => {
				setDetail({ loading: true, data: null, error: null, name: skill.name })
				apiGet('/skill', { path: skill.path }, sessionId)
					.then((data) => setDetail({ loading: false, data, error: null, name: skill.name }))
					.catch((error) => setDetail({ loading: false, data: null, error: actionError(t, error), name: skill.name }))
			}

			/** 启停一项：成功就整表重拉，并把 takeover 讲清楚。 */
			const toggle = (skill, enabled) => {
				setActionFail(null)
				setNotice(null)
				setBusyPath(skill.path)
				apiPost('/toggle', { path: skill.path, enabled }, sessionId)
					.then((data) => {
						const takeover = data && Array.isArray(data.takeover) ? data.takeover : []
						if (takeover.length > 0) {
							// 宿主在 takeover 条目里直接给了 label（与分组标题同一份文案），优先级最高。
							const names = takeover
								.map((entry) => rootLabel(t, entry.root, entry.label || labelOfRoot(env.data, entry.root)))
								.join('、')
							setNotice(t('skills.takeover', { name: skill.name || '', roots: names }))
						} else {
							setNotice(t('skills.toggled', { name: skill.name || '', state: t(enabled ? 'skills.stateOn' : 'skills.stateOff') }))
						}
						// 只发信号，重拉由依赖 revision 的 effect 做——两处都拉会打两次 /catalog。
						bumpCatalog()
					})
					.catch((error) => setActionFail(actionError(t, error)))
					.finally(() => setBusyPath(null))
			}

			/** 一整组的批量启停：只发需要变的项（宿主上限 200）。 */
			const batch = (root, enabled) => {
				const items = (Array.isArray(root.skills) ? root.skills : [])
					.filter((skill) => skill.toggleable !== false && skill.enabled !== enabled && typeof skill.path === 'string')
					.map((skill) => ({ path: skill.path, enabled }))
				if (items.length === 0) {
					setNotice(t('skills.toggled', { name: rootLabel(t, root.key, root.label), state: t(enabled ? 'skills.stateOn' : 'skills.stateOff') }))
					return
				}
				setBatchBusy(true)
				setActionFail(null)
				setNotice(null)
				apiPost('/toggle-batch', { items }, sessionId)
					.then((data) => {
						const results = data && Array.isArray(data.results) ? data.results : []
						const failed = results.filter((entry) => entry && entry.ok !== true)
						const changed = data && typeof data.changed === 'number' ? data.changed : items.length - failed.length
						setNotice(failed.length > 0 ? t('skills.batchResult', { changed }) + '，' + t('skills.batchFailed', { failed: failed.length }) : t('skills.batchResult', { changed }))
						bumpCatalog()
					})
					.catch((error) => setActionFail(actionError(t, error)))
					.finally(() => setBatchBusy(false))
			}

			// 删除 / 移到项目之后，详情与目录都可能过期，一起重来。
			const reloadAfterAction = () => {
				setDetail(null)
				loadCatalog()
			}

			const projectLabelOf = () => {
				const entry = projects.find((item) => item && item.sessionId === activeProject) ?? projects[0]
				return entry === undefined ? '' : projectNameOf(entry)
			}

			const removeSkillFile = (skill, rootName) => {
				if (busyPath !== null) return
				if (!askConfirm(deleteConfirmText(t, skill, rootName))) return
				setBusyPath(skill.path)
				setNotice(null)
				setActionFail(null)
				apiPost('/skills/delete', { path: skill.path }, sessionId)
					.then((data) => {
						// 备份落在 DSH_HOME 下，是绝对路径：面板不显示具体目录地址，所以只报「已备份」。
						setNotice(t('skills.deleteDone', { name: data.name || skill.name || '' }))
						reloadAfterAction()
					})
					.catch((error) => setActionFail(actionError(t, error)))
					.then(() => setBusyPath(null))
			}

			const moveSkillToProject = (skill) => {
				if (busyPath !== null) return
				if (!askConfirm(moveConfirmText(t, skill, projectLabelOf()))) return
				setBusyPath(skill.path)
				setNotice(null)
				setActionFail(null)
				apiPost('/skills/move-to-project', { path: skill.path }, sessionId)
					.then((data) => {
						if (data.globalRemoved === false) setNotice(t('skills.movePartial', { warning: data.warning ?? '' }))
						else setNotice(t('skills.moveDone', { name: data.name || skill.name || '' }))
						reloadAfterAction()
					})
					.catch((error) => setActionFail(actionError(t, error)))
					.then(() => setBusyPath(null))
			}

			const project = catalog.data && catalog.data.project ? catalog.data.project : null
			const collisions = catalog.data && Array.isArray(catalog.data.collisions) ? catalog.data.collisions : []
			const warnings = catalog.data && Array.isArray(catalog.data.warnings) ? catalog.data.warnings : []
			const roots = catalog.data && Array.isArray(catalog.data.roots) ? catalog.data.roots : []

			return h(
				'div',
				{ className: 'sc-body' },
				// 范围 + 项目 + 刷新
				h(
					'div',
					{ className: 'sc-bar' },
					h('span', { className: 'sc-hint' }, t('skills.scope')),
					h(UiPill, { active: scope === 'global', onClick: () => setScope('global'), children: t('skills.scope.global') }),
					h(UiPill, { active: scope === 'project', onClick: () => setScope('project'), children: t('skills.scope.project') }),
					scope === 'project' && projects.length > 0
						? h(
								'select',
								{
									className: 'sc-select',
									value: activeProject,
									'aria-label': t('skills.project'),
									onChange: (event) => setProjectPick(projectOptions.find((option) => option.value === event.target.value) ?? null),
								},
								projectOptions.map((option) => h('option', { key: option.value, value: option.value }, option.label)),
							)
						: null,
					h('span', { className: 'sc-spacer' }),
					h(UiButton, {
						variant: 'ghost',
						size: 'sm',
						icon: UiIcon('IconRefreshOutline16', 14),
						disabled: catalog.loading,
						onClick: () => bumpCatalog(),
						children: t('common.refresh'),
					}),
				),
				// 项目解析说明——回落到别的项目时绝不能装作没事。面板只显示项目名，
				// 不显示任何具体目录地址（用户要知道「是不是这个项目」，不需要知道绝对路径）。
				project
					? h(
							'div',
							{ className: 'sc-hint' },
							t('skills.projectName', { name: projectNameOf(project) }),
							project.fallback === true
								? h('div', { className: 'sc-warn' }, UiIcon('IconWarningOutline16', 13), h('span', null, project.cwd ? t('skills.projectFallback', { name: projectNameOf(project) }) : t('skills.projectFallbackUnknown')))
								: null,
						)
					: null,
				scope === 'project' && !env.loading && projects.length === 0 ? h('div', { className: 'sc-note' }, t('skills.noSessions')) : null,
				env.error ? h('div', { className: 'sc-err' }, actionError(t, new Error(env.error))) : null,
				notice ? h('div', { className: 'sc-ok', role: 'status' }, notice) : null,
				actionFail ? h('div', { className: 'sc-err', role: 'alert' }, actionFail) : null,
				catalog.error ? h('div', { className: 'sc-err', role: 'alert' }, catalog.error) : null,
				warnings.length > 0
					? h(
							'div',
							{ className: 'sc-note' },
							warnings.map((warning, index) =>
								h('div', { key: 'warning-' + index, className: 'sc-warn' }, UiIcon('IconWarningOutline16', 13), h('span', null, codeText(t, warning && warning.code, warning && warning.message))),
							),
						)
					: null,
				// 同名技能冲突：谁生效、谁被盖住，直接说。
				collisions.length > 0
					? h(
							'div',
							{ className: 'sc-note' },
							h('div', { className: 'sc-group-title' }, t('skills.collisions')),
							collisions.map((collision, index) =>
								h(
									'div',
									{ key: 'collision-' + index, className: 'sc-hint' },
									t('skills.collisionRow', {
										name: collision && collision.name ? collision.name : '—',
										winner: rootLabel(t, collision && collision.winner && collision.winner.root, labelOfRoot(catalog.data, collision && collision.winner && collision.winner.root)),
										shadowed: (Array.isArray(collision && collision.shadowed) ? collision.shadowed : [])
											.map((entry) => rootLabel(t, entry && entry.root, labelOfRoot(catalog.data, entry && entry.root)))
											.join('、'),
									}),
								),
							),
						)
					: null,
				detail ? h(SkillDetail, { t, state: detail, onClose: () => setDetail(null) }) : null,
				catalog.loading && !catalog.data ? h('div', { className: 'sc-empty' }, t('skills.loading')) : null,
				roots.map((root) =>
					h(SkillGroup, {
						key: root.key || root.path || '',
						t,
						root,
						busyPath,
						onOpen: loadDetail,
						onToggle: toggle,
						onBatch: batch,
						onDelete: removeSkillFile,
						onMove: moveSkillToProject,
					}),
				),
				roots.length > 0 && batchBusy ? h('div', { className: 'sc-hint' }, t('common.loading')) : null,
			)
		}

		// ── 技能仓库标签页 ────────────────────────────────────────────────────

		/** `data.roots[]` / `data.roots`（catalog）里查根 label 的小工具。 */
		function labelOfRoot(data, key) {
			if (!data || !Array.isArray(data.roots) || typeof key !== 'string') return null
			const found = data.roots.find((root) => root && root.key === key)
			return found && typeof found.label === 'string' ? found.label : null
		}

		/** 添加仓库表单。受控组件定义在工厂作用域，输入框不会因为父组件重渲染而失焦。 */
		function RepoAddForm(props) {
			const t = props.t
			return h(
				'div',
				{ className: 'sc-card' },
				h('span', { className: 'sc-group-title' }, t('repos.addTitle')),
				h(
					'div',
					{ className: 'sc-form' },
					h(
						'label',
						{ className: 'sc-field sc-field-wide' },
						h('span', { className: 'sc-field-label' }, t('repos.addUrl')),
						h(UiInput, {
							value: props.form.url,
							placeholder: t('repos.addUrlPlaceholder'),
							disabled: props.busy,
							onChange: (event) => props.onField('url', event.target.value),
							onKeyDown: (event) => {
								if (event.key === 'Enter') props.onSubmit()
							},
						}),
					),
					h(
						'label',
						{ className: 'sc-field' },
						h('span', { className: 'sc-field-label' }, t('repos.addRef')),
						h(UiInput, {
							value: props.form.ref,
							placeholder: t('repos.addRefPlaceholder'),
							disabled: props.busy,
							onChange: (event) => props.onField('ref', event.target.value),
						}),
					),
					h(
						'label',
						{ className: 'sc-field' },
						h('span', { className: 'sc-field-label' }, t('repos.addSubdir')),
						h(UiInput, {
							value: props.form.subdirectory,
							placeholder: t('repos.addSubdirPlaceholder'),
							disabled: props.busy,
							onChange: (event) => props.onField('subdirectory', event.target.value),
						}),
					),
					h(UiButton, {
						variant: 'primary',
						disabled: props.busy || props.form.url.trim() === '',
						onClick: props.onSubmit,
						children: props.busy ? t('repos.adding') : t('repos.add'),
					}),
				),
				h(
					'div',
					{ className: 'sc-hint' },
					UiIcon('IconRefreshOutline16', 13),
					' ',
					h('span', null, t('repos.fetchHint')),
				),
			)
		}

		/**
		 * 订阅卡片：一行仓库信息 + 可折叠的技能明细。
		 *
		 * 技能明细必须长在**它所属的那个仓库**下面：以前它是面板底部另一张独立卡片，
		 * 于是用户既看不出这份明细属于哪个订阅，也没法把它收起来。
		 */
		function RepoRow(props) {
			const t = props.t
			const repo = props.repo || {}
			const status = repo.status && typeof repo.status === 'object' ? repo.status : {}
			const lastFetch = repo.lastFetch && typeof repo.lastFetch === 'object' ? repo.lastFetch : null
			const href = safeHref(repo.url)
			const expanded = props.expanded === true
			const fetchLine = lastFetch
				? lastFetch.error
					? t('repos.lastFetchError', { error: String(lastFetch.error) })
					: t('repos.lastFetchLine', {
							commit: lastFetch.commitShort || '—',
							time: relativeText(t, lastFetch.at),
							count: typeof lastFetch.skillCount === 'number' ? lastFetch.skillCount : 0,
						})
				: t('repos.lastFetchNever')
			const statusLine = t('repos.statusLine', {
				total: numberOr(status.total, 0),
				notInstalled: numberOr(status.notInstalled, 0),
				installed: numberOr(status.installed, 0),
				updateAvailable: numberOr(status.updateAvailable, 0),
				upstreamDeleted: numberOr(status.upstreamDeleted, 0),
			})
			return h(
				'div',
				{ className: 'sc-repo' + (expanded ? ' is-open' : '') },
				h(
					'div',
					{ className: 'sc-repo-head is-clickable', onClick: () => props.onToggle(repo) },
					// 整行头部都能点；这个按钮是给键盘 / 读屏用户的显式控件（也是唯一的展开状态来源）。
					h(
						'button',
						{
							type: 'button',
							className: 'sc-disclosure',
							'aria-expanded': expanded ? 'true' : 'false',
							title: t(expanded ? 'repos.collapse' : 'repos.expand'),
							onClick: stop(() => props.onToggle(repo)),
						},
						h('span', { className: 'sc-caret', 'data-open': expanded ? 'true' : 'false', 'aria-hidden': 'true' }),
						h('span', null, t(expanded ? 'repos.collapse' : 'repos.expand')),
					),
					h(
						'div',
						{ className: 'sc-row-main' },
						h(
							'div',
							{ className: 'sc-row-head' },
							// 点仓库名是去 GitHub，不该顺带把卡片也折叠了。
							href
								? h('a', { className: 'sc-link sc-name', href, target: '_blank', rel: 'noreferrer', onClick: stop(null) }, repo.id || href)
								: h('span', { className: 'sc-name' }, repo.id || '—'),
							h(UiTag, { tone: 'quiet' }, repo.ref ? t('repos.ref', { ref: repo.ref }) : t('repos.refDefault')),
							repo.subdirectory ? h(UiTag, { tone: 'quiet' }, t('repos.subdir', { path: repo.subdirectory })) : null,
						),
						h('span', { className: 'sc-desc' }, fetchLine),
						h('span', { className: 'sc-hint' }, statusLine),
						numberOr(status.invalid, 0) + numberOr(status.conflict, 0) > 0
							? h('span', { className: 'sc-warn' }, UiIcon('IconWarningOutline16', 13), h('span', null, t('repos.statusExtra', { invalid: numberOr(status.invalid, 0), conflict: numberOr(status.conflict, 0) })))
							: null,
					),
					// 三个管理动作并列：编辑设置 / 更新（拉取最新）/ 删除订阅。
					h(
						'div',
						{ className: 'sc-row-actions' },
						h(UiButton, {
							variant: 'ghost',
							size: 'sm',
							icon: UiIcon('IconEditOutline16', 14),
							disabled: props.busy,
							onClick: stop(() => props.onEdit(repo)),
							children: t('repos.edit'),
						}),
						h(UiTooltip, {
							label: t('repos.fetchTitle'),
							side: 'top',
							children: h(UiButton, {
								variant: 'outline',
								size: 'sm',
								icon: UiIcon('IconRefreshOutline16', 14),
								disabled: props.busy,
								onClick: stop(() => props.onFetch(repo)),
								children: t('repos.fetch'),
							}),
						}),
						h(UiButton, { variant: 'danger', size: 'sm', icon: UiIcon('IconTrashOutline16', 14), disabled: props.busy, onClick: stop(() => props.onRemove(repo)), children: t('repos.remove') }),
					),
				),
				props.editing
					? h(RepoEditForm, {
							t,
							repo,
							form: props.editForm,
							busy: props.busy,
							onField: props.onEditField,
							onSave: props.onEditSave,
							onCancel: props.onEditCancel,
						})
					: null,
				expanded
					? h(RepoSkills, {
							t,
							busy: props.busy,
							detail: props.detail,
							picked: props.picked,
							installResult: props.installResult,
							emptyDetailKey: props.emptyDetailKey,
							installTarget: props.installTarget,
							onInstallTarget: props.onInstallTarget,
							onTogglePick: props.onTogglePick,
							onSelectAll: props.onSelectAll,
							onClearPicked: props.onClearPicked,
							onInstall: props.onInstall,
							onRestore: props.onRestore,
						})
					: null,
			)
		}

		/**
		 * 展开后的技能明细：勾选 + 安装/更新 + 恢复上一版 + 空态 / 加载 / 错误 / 安装结果。
		 *
		 * 每个仓库各持一份明细与勾选：勾选不会因为展开另一个仓库、或刷新列表而丢。
		 */
		function RepoSkills(props) {
			const t = props.t
			const detail = props.detail && typeof props.detail === 'object' ? props.detail : {}
			const picked = props.picked && typeof props.picked === 'object' ? props.picked : {}
			const skills = detail.data && Array.isArray(detail.data.skills) ? detail.data.skills : []
			const pickedNames = skills.filter((skill) => picked[skill.name] === true).map((skill) => skill.name)
			const installResult = props.installResult && typeof props.installResult === 'object' ? props.installResult : null
			const installedRows = installResult && Array.isArray(installResult.installed) ? installResult.installed : []
			const skippedRows = installResult && Array.isArray(installResult.skipped) ? installResult.skipped : []
			return h(
				'div',
				{ className: 'sc-repo-body' },
				h(
					'div',
					{ className: 'sc-bar' },
					h('span', { className: 'sc-group-title' }, t('repos.detailTitle')),
					h('span', { className: 'sc-hint' }, t('repos.skillCount', { count: skills.length })),
					h('span', { className: 'sc-spacer' }),
					h('span', { className: 'sc-hint' }, t('repos.selected', { count: pickedNames.length })),
					h(UiButton, { variant: 'ghost', size: 'sm', disabled: props.busy || skills.length === 0, onClick: props.onSelectAll, children: t('repos.selectAll') }),
					h(UiButton, { variant: 'ghost', size: 'sm', disabled: props.busy || pickedNames.length === 0, onClick: props.onClearPicked, children: t('repos.selectNone') }),
					h(UiButton, { variant: 'primary', disabled: props.busy || pickedNames.length === 0, icon: UiIcon('IconDownloadOutline16', 14), onClick: props.onInstall, children: t('repos.install') }),
				),
				// 安装目标：全局技能根（缺省）或当前项目技能根。缺省 global 时这一行照样显示，只是高亮在全局。
				h(
					'div',
					{ className: 'sc-bar' },
					h('span', { className: 'sc-hint' }, t('repos.installTarget')),
					h(UiPill, { active: props.installTarget !== 'project', onClick: () => props.onInstallTarget('global'), children: t('repos.targetGlobal') }),
					h(UiPill, { active: props.installTarget === 'project', onClick: () => props.onInstallTarget('project'), children: t('repos.targetProject') }),
					props.installTarget === 'project' ? h('span', { className: 'sc-hint' }, t('repos.targetProjectHint')) : null,
				),
				detail.error ? h('div', { className: 'sc-err', role: 'alert' }, detail.error) : null,
				detail.loading ? h('div', { className: 'sc-hint' }, t('repos.detailLoading')) : null,
				!detail.loading && !detail.error && skills.length === 0 ? h('div', { className: 'sc-empty' }, t(props.emptyDetailKey || 'repos.detailEmpty')) : null,
				skills.length > 0
					? h(
							'div',
							{ className: 'sc-group' },
							skills.map((skill) =>
								h(RepoSkillRow, {
									key: skill.sourcePath || skill.name || '',
									t,
									skill,
									selected: picked[skill.name] === true,
									busy: props.busy,
									onSelect: props.onTogglePick,
									onRestore: props.onRestore,
								}),
							),
						)
					: null,
				installResult
					? h(
							'div',
							{ className: 'sc-stack' },
							h('span', { className: 'sc-group-title' }, t('repos.installResult')),
							installedRows.map((entry, index) =>
								h(
									'div',
									{ key: 'installed-' + index, className: 'sc-ok' },
									t('repos.installedRow', { name: entry.name, state: t(entry.updated ? 'repos.installedStateUpdated' : 'repos.installedStateNew') }),
									entry.backup ? h('div', { className: 'sc-hint' }, t('repos.installedBackup', { path: baseName(entry.backup) })) : null,
								),
							),
							skippedRows.map((entry, index) =>
								h('div', { key: 'skipped-' + index, className: 'sc-warn' }, UiIcon('IconWarningOutline16', 13), h('span', null, t('repos.skippedRow', { name: entry.name, reason: entry.reason || '' }))),
							),
						)
					: null,
			)
		}

		/**
		 * 订阅的编辑表单（行内展开，不用 Modal）：只改分支/子目录。
		 *
		 * 地址是订阅的身份（`owner/name` 决定 id 与已安装技能的归属），所以这里只读展示、
		 * 不给输入框——想换仓库就得走「移除订阅 + 添加」。
		 */
		function RepoEditForm(props) {
			const t = props.t
			const repo = props.repo || {}
			const form = props.form || {}
			return h(
				'div',
				{ className: 'sc-edit' },
				h('span', { className: 'sc-group-title' }, t('repos.editTitle', { id: repo.id || '—' })),
				h(
					'div',
					{ className: 'sc-form' },
					h(
						'label',
						{ className: 'sc-field' },
						h('span', { className: 'sc-field-label' }, t('repos.addRef')),
						h(UiInput, {
							value: form.ref || '',
							placeholder: t('repos.addRefPlaceholder'),
							disabled: props.busy,
							onChange: (event) => props.onField('ref', event.target.value),
							onKeyDown: (event) => {
								if (event.key === 'Enter') props.onSave()
								if (event.key === 'Escape') props.onCancel()
							},
						}),
					),
					h(
						'label',
						{ className: 'sc-field' },
						h('span', { className: 'sc-field-label' }, t('repos.addSubdir')),
						h(UiInput, {
							value: form.subdirectory || '',
							placeholder: t('repos.addSubdirPlaceholder'),
							disabled: props.busy,
							onChange: (event) => props.onField('subdirectory', event.target.value),
							onKeyDown: (event) => {
								if (event.key === 'Enter') props.onSave()
								if (event.key === 'Escape') props.onCancel()
							},
						}),
					),
					h(UiButton, { variant: 'primary', size: 'sm', disabled: props.busy, onClick: props.onSave, children: props.busy ? t('repos.editing') : t('repos.editSave') }),
					h(UiButton, { variant: 'ghost', size: 'sm', disabled: props.busy, onClick: props.onCancel, children: t('repos.editCancel') }),
				),
				h('div', { className: 'sc-hint' }, t('repos.editHint')),
			)
		}

		/** 仓库里的一个技能行：状态 + 本地改动 + 变更文件 + 勾选 + 恢复备份。 */
		function RepoSkillRow(props) {
			const t = props.t
			const skill = props.skill || {}
			const status = typeof skill.status === 'string' ? skill.status : ''
			const statusKey = STATUS_KEYS[status] || 'repos.skill.invalid'
			const statusTone = status === 'installed' ? 'success' : status === 'update-available' || status === 'invalid' ? 'warning' : status === 'upstream-deleted' ? 'danger' : 'quiet'
			const installable = typeof skill.name === 'string' && skill.name !== '' && skill.valid !== false
			const changed = Array.isArray(skill.changedFiles) ? skill.changedFiles : []
			return h(
				'div',
				{ className: 'sc-row' },
				h(
					'div',
					{ className: 'sc-row-main' },
					h(
						'div',
						{ className: 'sc-row-head' },
						h('span', { className: 'sc-name' }, skill.name || skill.sourcePath || '—'),
						h(UiTag, { tone: statusTone }, t(statusKey)),
						skill.localModified ? h(UiTag, { tone: 'warning' }, t('repos.localModified')) : null,
						// conflict 与 localModified 是两个正交标记：前者是「本地有同名技能但不属于本订阅」，
						// 后者是「本地内容与安装快照不一致」。requiresConfirm 是两者的并集，不能拿来当标签。
						skill.conflict === true ? h(UiTag, { tone: 'danger' }, t('repos.conflict')) : null,
						status === 'upstream-deleted' ? h(UiTag, { tone: 'quiet' }, skill.sourcePath || '') : null,
					),
					h('span', { className: 'sc-desc' }, skill.description || t('skills.noDescription')),
					h(
						'span',
						{ className: 'sc-meta' },
						skill.sourcePath || '',
						typeof skill.files === 'number' ? ' · ' + t('repos.meta', { files: skill.files, size: bytesText(skill.bytes) }) : '',
					),
					changed.length > 0
						? h(
								'div',
								{ className: 'sc-changed' },
								h('span', { className: 'sc-hint' }, t('repos.changedFiles') + '：'),
								changed.map((entry, index) =>
									h(
										'span',
										{ key: 'change-' + index, className: 'sc-change', 'data-change': entry && entry.change ? entry.change : 'unknown', title: entry && entry.path ? entry.path : '' },
										changeMark(t, entry && entry.change) + ' ' + (entry && entry.path ? entry.path : ''),
									),
								),
							)
						: null,
				),
				h(
					'div',
					{ className: 'sc-actions-col sc-row-actions' },
					installable
						? h(UiSwitch, {
								checked: props.selected === true,
								disabled: props.busy,
								label: t('skills.toggleAria', { name: skill.name }),
								onChange: (next) => props.onSelect(skill, next),
							})
						: h(UiTag, { tone: 'danger' }, t('repos.skill.invalid')),
					// 只有真的属于本订阅（不是本地同名冲突）的已安装技能才谈得上「恢复上一版」。
					skill.installedPath && skill.conflict !== true
						? h(UiButton, {
								variant: 'ghost',
								size: 'sm',
								icon: UiIcon('IconDownloadOutline16', 14),
								disabled: props.busy,
								onClick: () => props.onRestore(skill),
								children: t('repos.restore'),
							})
						: null,
				),
			)
		}

		/** 上游状态 → 字典键。 */
		const STATUS_KEYS = {
			'not-installed': 'repos.skill.not-installed',
			installed: 'repos.skill.installed',
			'update-available': 'repos.skill.update-available',
			'upstream-deleted': 'repos.skill.upstream-deleted',
		}

		/**
		 * 空清单时该说哪句话。
		 *
		 * 「还没拉取过」与「拉取成功了但一个技能都没有」是两种情况：后者最常见的原因是
		 * 子目录没指到放技能的那一层（仓库根下的 README / CONTRIBUTING 不算技能），
		 * 这时让用户去点「拉取最新」是白跑一趟，得直接说可能是子目录填错了。
		 *
		 * @param repo - 订阅列表里的一行（用它的 `lastFetch` 判断拉取是否成功过）。
		 * @returns 字典键。
		 */
		function emptyDetailKeyFor(repo) {
			const lastFetch = repo && repo.lastFetch && typeof repo.lastFetch === 'object' ? repo.lastFetch : null
			return lastFetch !== null && !lastFetch.error ? 'repos.detailNoSkills' : 'repos.detailEmpty'
		}

		/** 变更类型 → 单字标记（表头里有完整说明，这里只做紧凑标记）。 */
		function changeMark(t, change) {
			if (change === 'added') return t('repos.change.added')
			if (change === 'removed') return t('repos.change.removed')
			if (change === 'modified') return t('repos.change.modified')
			return t('repos.change.unknown')
		}

		/** 数字兜底。 */
		function numberOr(value, fallback) {
			return typeof value === 'number' && Number.isFinite(value) ? value : fallback
		}

		/** 技能仓库标签页：订阅列表 + 详情 + 手动拉取/安装/恢复。 */
		function ReposPanel(props) {
			const t = props.t
			const sessionId = props.sessionId
			const [list, setList] = react.useState({ loading: true, data: null, error: null })
			// 展开状态 `id -> true`：每个订阅各自独立，可以同时展开好几个。
			const [open, setOpen] = react.useState({})
			// 明细 `id -> { loading, data, error }`：展开哪个仓库就只读那个仓库。
			const [details, setDetails] = react.useState({})
			// 勾选 `id -> { 技能名: true }`：展开另一个仓库不该把这里的勾选弄丢。
			const [picked, setPicked] = react.useState({})
			const [busy, setBusy] = react.useState(false)
			const [notice, setNotice] = react.useState(null)
			const [actionFail, setActionFail] = react.useState(null)
			// 安装结果 `id -> { installed, skipped }`，跟着它所属的那个仓库显示。
			const [installResult, setInstallResult] = react.useState({})
			// 安装目标：全局技能根（缺省）还是当前项目技能根。
			const [installTarget, setInstallTarget] = react.useState('global')
			const [form, setForm] = react.useState({ url: '', ref: '', subdirectory: '' })
			// 正在编辑的订阅：`id === ''` 表示没有行处于编辑态。
			const [edit, setEdit] = react.useState({ id: '', form: { ref: '', subdirectory: '' } })
			const listToken = react.useRef(0)
			// 每个订阅各自的拉取序号：同时展开两个仓库时，先发出的那次不能盖掉后发出的。
			const detailTokens = react.useRef({})
			// 首次拿到列表后自动展开第一个订阅；用户自己全部收起之后就不再自动展开。
			const autoOpen = react.useRef(false)

			const loadList = () => {
				const run = ++listToken.current
				setList((previous) => ({ loading: true, data: previous.data, error: null }))
				return apiGet('/repositories', null, sessionId)
					.then((data) => {
						if (listToken.current !== run) return
						setList({ loading: false, data, error: null })
					})
					.catch((error) => {
						if (listToken.current !== run) return
						setList((previous) => ({ loading: false, data: previous.data, error: errorMessage(t, error) }))
					})
			}

			const loadDetail = (id) => {
				const run = (detailTokens.current[id] = numberOr(detailTokens.current[id], 0) + 1)
				// 保留上一次的明细：刷新时旧内容继续显示，不闪成空白。
				setDetails((previous) => ({ ...previous, [id]: { loading: true, data: (previous[id] && previous[id].data) || null, error: null } }))
				return apiGet('/repositories/detail', { id }, sessionId)
					.then((data) => {
						if (numberOr(detailTokens.current[id], 0) !== run) return null
						setDetails((previous) => ({ ...previous, [id]: { loading: false, data, error: null } }))
						return data
					})
					.catch((error) => {
						if (numberOr(detailTokens.current[id], 0) !== run) return null
						setDetails((previous) => ({ ...previous, [id]: { loading: false, data: null, error: errorMessage(t, error) } }))
						return null
					})
			}

			react.useEffect(() => {
				// 会话一换，整页的身份就换了：把「自动展开过没有」和挂在各个仓库上的
				// 展开 / 明细 / 勾选 / 结果全部复位，免得把上一个工作区的状态带过来。
				autoOpen.current = false
				setOpen({})
				setDetails({})
				setPicked({})
				setInstallResult({})
				setEdit({ id: '', form: { ref: '', subdirectory: '' } })
				loadList()
				// eslint-disable-next-line react-hooks/exhaustive-deps -- 只在会话变化时重挂一次；其余刷新都由用户点击驱动。
			}, [sessionId])

			// 首次拿到列表后自动展开第一个订阅（否则用户不知道技能明细藏在哪里）。
			react.useEffect(() => {
				const repos = list.data && Array.isArray(list.data.repositories) ? list.data.repositories : []
				if (repos.length === 0) return
				if (Object.keys(open).length > 0) return
				if (autoOpen.current === true) return
				autoOpen.current = true
				const first = repos[0]
				if (first && typeof first.id === 'string' && first.id !== '') {
					setOpen({ [first.id]: true })
					loadDetail(first.id)
				}
				// eslint-disable-next-line react-hooks/exhaustive-deps -- 同上。
			}, [list.data, open])

			const repositories = list.data && Array.isArray(list.data.repositories) ? list.data.repositories : []
			const openedCount = Object.keys(open).filter((id) => open[id] === true).length

			/** 某个订阅当前的技能清单（明细没到就是空数组）。 */
			const skillsOf = (id) => {
				const entry = details[id]
				return entry && entry.data && Array.isArray(entry.data.skills) ? entry.data.skills : []
			}

			/** 某个订阅当前勾中的技能名（按清单过滤，避免留下已经消失的名字）。 */
			const pickedNamesOf = (id) => {
				const marks = picked[id] && typeof picked[id] === 'object' ? picked[id] : {}
				return skillsOf(id).filter((skill) => marks[skill.name] === true).map((skill) => skill.name)
			}

			const run = (fn) => {
				setBusy(true)
				setActionFail(null)
				return fn()
					.catch((error) => {
						setActionFail(actionError(t, error))
						return null
					})
					.finally(() => setBusy(false))
			}

			/** 展开 / 收起一个订阅。收起只是藏起来，明细留着，再展开立刻就有内容。 */
			const toggleRepo = (repo) => {
				const id = repo && typeof repo.id === 'string' ? repo.id : ''
				if (id === '') return undefined
				if (open[id] === true) {
					setOpen((previous) => {
						const next = { ...previous }
						delete next[id]
						return next
					})
					return undefined
				}
				setOpen((previous) => ({ ...previous, [id]: true }))
				// 上一轮的安装结果跟着它那次操作结束，重新展开时不该继续挂着。
				setInstallResult((previous) => {
					if (!(id in previous)) return previous
					const next = { ...previous }
					delete next[id]
					return next
				})
				return loadDetail(id)
			}

			const collapseAll = () => {
				setOpen({})
				setInstallResult({})
			}

			/** 订阅没了：把挂在它身上的展开 / 明细 / 勾选 / 结果一并清掉，避免留下孤儿状态。 */
			const forgetRepo = (id) => {
				const drop = (previous) => {
					if (!(id in previous)) return previous
					const next = { ...previous }
					delete next[id]
					return next
				}
				setOpen(drop)
				setDetails(drop)
				setPicked(drop)
				setInstallResult(drop)
				delete detailTokens.current[id]
			}

			/**
			 * 「拉取最新」——用户点名要的那个手动动作。只刷新远端清单；
			 * 宿主不碰本地技能文件，界面也不替用户顺手安装。
			 */
			const fetchLatest = (repo) =>
				run(() =>
					apiPost('/repositories/fetch', { id: repo.id }, sessionId).then((data) => {
						setNotice(t('repos.fetchDone', { id: repo.id }))
						setOpen((previous) => ({ ...previous, [repo.id]: true }))
						setPicked((previous) => ({ ...previous, [repo.id]: {} }))
						setDetails((previous) => ({ ...previous, [repo.id]: { loading: false, data, error: null } }))
						return loadList()
					}),
				)

			const removeRepo = (repo) => {
				if (!askConfirm(t('repos.removeConfirm', { id: repo.id }))) return undefined
				return run(() =>
					apiPost('/repositories/remove', { id: repo.id }, sessionId).then((data) => {
						setNotice(t('repos.removed', { id: repo.id, count: Array.isArray(data.installedKept) ? data.installedKept.length : 0 }))
						forgetRepo(repo.id)
						if (edit.id === repo.id) setEdit({ id: '', form: { ref: '', subdirectory: '' } })
						return loadList()
					}),
				)
			}

			/** 展开某一行的编辑表单（同时把别处的提示收起来，避免串行误读）。 */
			const startEdit = (repo) => {
				setNotice(null)
				setActionFail(null)
				setInstallResult((previous) => {
					if (!(repo.id in previous)) return previous
					const next = { ...previous }
					delete next[repo.id]
					return next
				})
				setEdit({ id: repo.id, form: { ref: repo.ref || '', subdirectory: repo.subdirectory || '' } })
			}

			const cancelEdit = () => setEdit({ id: '', form: { ref: '', subdirectory: '' } })

			/**
			 * 保存编辑：分支/子目录真的变了，宿主会丢掉旧清单并立刻重拉。
			 * 拉取失败不回滚订阅设置（订阅本身是好的），而是把失败原因说出来。
			 */
			const saveEdit = () =>
				run(() =>
					apiPost('/repositories/update', { id: edit.id, ref: edit.form.ref.trim(), subdirectory: edit.form.subdirectory.trim() }, sessionId).then((data) => {
						const id = data && data.repository && typeof data.repository.id === 'string' ? data.repository.id : edit.id
						setNotice(t(data && data.changed === false ? 'repos.editUnchanged' : 'repos.edited', { id }))
						if (data && data.fetchError) setActionFail(t('repos.editFetchError', { error: String(data.fetchError) }))
						cancelEdit()
						setPicked((previous) => ({ ...previous, [id]: {} }))
						if (data && data.repository) setDetails((previous) => ({ ...previous, [id]: { loading: false, data: { repository: data.repository, skills: data.skills || [] }, error: null } }))
						return loadList()
					}),
				)

			const addRepo = () =>
				run(() =>
					apiPost('/repositories/add', { url: form.url.trim(), ref: form.ref.trim(), subdirectory: form.subdirectory.trim() }, sessionId).then((data) => {
						const added = data && data.repository && typeof data.repository.id === 'string' ? data.repository.id : ''
						setNotice(t('repos.added', { id: added || form.url.trim() }))
						if (data && data.fetchError) setActionFail(t('repos.addFetchError', { error: String(data.fetchError) }))
						setForm({ url: '', ref: '', subdirectory: '' })
						// 刚加的订阅直接展开：用户添加它就是为了看里面有什么技能。
						if (added !== '') {
							setOpen((previous) => ({ ...previous, [added]: true }))
							setPicked((previous) => ({ ...previous, [added]: {} }))
							setDetails((previous) => ({ ...previous, [added]: { loading: false, data: { repository: data.repository, skills: data.skills || [] }, error: null } }))
						}
						return loadList()
					}),
				)

			const togglePick = (id, skill, next) => {
				if (typeof skill.name !== 'string' || skill.name === '') return
				setPicked((previous) => ({ ...previous, [id]: { ...(previous[id] || {}), [skill.name]: next } }))
			}

			const selectAll = (id) => {
				const next = {}
				for (const skill of skillsOf(id)) {
					if (typeof skill.name === 'string' && skill.name !== '' && skill.valid !== false && skill.status !== 'installed' && skill.status !== 'upstream-deleted') {
						next[skill.name] = true
					}
				}
				setPicked((previous) => ({ ...previous, [id]: next }))
			}

			const clearPicked = (id) => setPicked((previous) => ({ ...previous, [id]: {} }))

			/** 安装/更新选中：有本地改动就先让用户确认，再带 confirm:true 重发。 */
			const install = (id) => {
				const names = pickedNamesOf(id)
				if (names.length === 0) {
					setActionFail(t('repos.installNone'))
					return undefined
				}
				const marks = picked[id] && typeof picked[id] === 'object' ? picked[id] : {}
				const needsConfirm = skillsOf(id).filter((skill) => marks[skill.name] === true && skill.requiresConfirm === true)
				let confirm = false
				if (needsConfirm.length > 0) {
					const listed = needsConfirm.map((skill) => skill.name).join('、')
					if (!askConfirm(t('repos.confirmOverwrite', { names: listed }))) return undefined
					confirm = true
				}
				return run(() =>
					apiPost('/repositories/install', { id, skills: names, confirm, target: installTarget }, sessionId).then((data) => {
						setInstallResult((previous) => ({
							...previous,
							[id]: {
								installed: data && Array.isArray(data.installed) ? data.installed : [],
								skipped: data && Array.isArray(data.skipped) ? data.skipped : [],
							},
						}))
						setNotice(t('repos.installDone', { count: names.length }))
						setPicked((previous) => ({ ...previous, [id]: {} }))
						// 技能目录确实变了：让技能标签页也跟着重读。
						bumpCatalog()
						return loadDetail(id).then(() => loadList())
					}),
				)
			}

			/**
			 * 恢复上一版：先问宿主有哪些备份，用最近一次做确认提示，用户点了才写。
			 * 备份不带「自动清理」，所以这里永远只恢复用户确认过的那一次。
			 */
			const restore = (id, skill) => {
				const name = typeof skill.name === 'string' ? skill.name : ''
				if (name === '') return undefined
				return run(() =>
					apiGet('/backups', { name }, sessionId).then((data) => {
						const backups = Array.isArray(data && data.backups) ? data.backups.slice() : []
						if (backups.length === 0) {
							setNotice(t('repos.restoreNone', { name }))
							return null
						}
						backups.sort((left, right) => numberOr(right.at, 0) - numberOr(left.at, 0))
						const latest = backups[0]
						const when = relativeText(t, latest.at)
						if (typeof latest.id !== 'string' || !askConfirm(t('repos.restoreConfirm', { name, time: when }))) return null
						return apiPost('/restore', { name, backup: latest.id }, sessionId).then((result) => {
							setNotice(t('repos.restored', { name: result && result.name ? result.name : name }))
							bumpCatalog()
							return loadDetail(id).then(() => loadList())
						})
					}),
				)
			}

			const tokenKnown = list.data && typeof list.data.token === 'boolean' ? list.data.token : null

			return h(
				'div',
				{ className: 'sc-body' },
				h(
					'div',
					{ className: 'sc-bar' },
					h('span', { className: 'sc-group-title' }, t('repos.subscribed')),
					tokenKnown === null ? null : h(UiTag, { tone: tokenKnown ? 'success' : 'quiet' }, t(tokenKnown ? 'repos.tokenOn' : 'repos.tokenOff')),
					h('span', { className: 'sc-spacer' }),
					openedCount > 0 ? h(UiButton, { variant: 'ghost', size: 'sm', disabled: busy, onClick: collapseAll, children: t('repos.collapseAll') }) : null,
					h(UiButton, {
						variant: 'ghost',
						size: 'sm',
						icon: UiIcon('IconRefreshOutline16', 14),
						disabled: busy || list.loading,
						onClick: () => loadList(),
						children: t('common.refresh'),
					}),
				),
				list.error ? h('div', { className: 'sc-err', role: 'alert' }, list.error) : null,
				notice ? h('div', { className: 'sc-ok', role: 'status' }, notice) : null,
				actionFail ? h('div', { className: 'sc-err', role: 'alert' }, actionFail) : null,
				list.loading && !list.data ? h('div', { className: 'sc-empty' }, t('common.loading')) : null,
				repositories.length === 0 && !list.loading ? h('div', { className: 'sc-empty' }, t('repos.empty')) : null,
				repositories.length > 0
					? h(
							'div',
							{ className: 'sc-repos' },
							repositories.map((repo) =>
								h(RepoRow, {
									key: repo.id,
									t,
									repo,
									expanded: open[repo.id] === true,
									busy,
									editing: edit.id === repo.id,
									editForm: edit.form,
									detail: details[repo.id],
									picked: picked[repo.id],
									installResult: installResult[repo.id],
									emptyDetailKey: emptyDetailKeyFor(repo),
									installTarget,
									onInstallTarget: setInstallTarget,
									onToggle: toggleRepo,
									onFetch: fetchLatest,
									onRemove: removeRepo,
									onEdit: startEdit,
									onEditField: (key, value) => setEdit((previous) => ({ ...previous, form: { ...previous.form, [key]: value } })),
									onEditSave: saveEdit,
									onEditCancel: cancelEdit,
									onTogglePick: (skill, next) => togglePick(repo.id, skill, next),
									onSelectAll: () => selectAll(repo.id),
									onClearPicked: () => clearPicked(repo.id),
									onInstall: () => install(repo.id),
									onRestore: (skill) => restore(repo.id, skill),
								}),
							),
						)
					: null,
				h(RepoAddForm, {
					t,
					form,
					busy,
					onField: (key, value) => setForm((previous) => ({ ...previous, [key]: value })),
					onSubmit: addRepo,
				}),
			)
		}

		// ── 分区外壳 ──────────────────────────────────────────────────────────

		/**
		 * 宿主 `/roles` 返回的对齐状态。
		 *
		 * 只认三个值，其余（旧宿主、字段缺失）一律当 `unassigned`——界面宁可
		 * 少说一句，也不能因为读不懂就崩。
		 * @param data - `/roles` 的 `data`。
		 * @returns `'unassigned' | 'matched' | 'drifted'`。
		 */
		function roleStatusOf(data) {
			const status = data !== null && typeof data === 'object' ? data.status : undefined
			return status === 'matched' || status === 'drifted' ? status : 'unassigned'
		}

		// ── 角色 ──────────────────────────────────────────────────────────────
		//
		// 角色是「项目技能根的一组开关状态」，不是另一套技能。面板只做两件事：
		// 把当前项目技能与角色的差异讲清楚，以及在用户确认后落盘。
		//
		// 全局技能在这里**只读**：DSH 没有「按项目遮蔽全局」的机制，角色管不到它们。
		// 界面必须把这件事说明白，否则用户会以为切了角色就只剩角色里的技能。

		/** 状态徽标的色调（`UiTag` 只认 danger / quiet / warning）。 */
		function roleToneOf(status) {
			if (status === 'matched') return 'quiet'
			if (status === 'drifted') return 'warning'
			return 'quiet'
		}

		/** 状态徽标的文案键。 */
		function roleStatusKey(status) {
			if (status === 'matched') return 'roles.statusMatched'
			if (status === 'drifted') return 'roles.statusDrifted'
			return 'roles.statusUnassigned'
		}

		/**
		 * 一个角色：名字 / 技能数 / 当前标记 + 三个动作。
		 * @param props - `{t, role, status, busy, onActivate, onEdit, onRemove}`。
		 */
		function RoleRow(props) {
			const t = props.t
			const role = props.role
			const active = role.active === true
			return h(
				'div',
				{ className: 'sc-row sc-role-row' },
				h(
					'div',
					{ className: 'sc-role-main' },
					h('span', { className: 'sc-role-name' }, role.name),
					h(UiTag, { tone: active ? roleToneOf(props.status) : 'quiet' }, active ? t(roleStatusKey(props.status)) : t('roles.statusUnassigned')),
					h('span', { className: 'sc-sub' }, t('roles.skillsCount', { count: role.skills.length })),
				),
				h(
					'div',
					{ className: 'sc-row-actions' },
					h(UiButton, { disabled: props.busy, onClick: props.onActivate }, t('roles.activate')),
					h(UiButton, { disabled: props.busy, onClick: props.onEdit }, t('roles.edit')),
					h(UiButton, { disabled: props.busy, onClick: props.onRemove }, t('roles.remove')),
				),
			)
		}

		/**
		 * 角色编辑器。
		 *
		 * 左栏是「项目技能」——角色真正能控制的部分，可勾选；
		 * 右栏是「全局技能」——只读展示，每条都带一句为什么。
		 *
		 * @param props - `{t, draft, candidates, missing, busy, onName, onToggle, onSave, onCancel, onActivate}`。
		 */
		function RoleEditor(props) {
			const t = props.t
			const draft = props.draft
			const picked = new Set(Array.isArray(draft.skills) ? draft.skills : [])
			const projectSkills = props.candidates?.project ?? []
			const globalSkills = props.candidates?.global ?? []
			const missing = props.missing ?? []

			// UiInput 把 rest 直接铺在原生 `<input>` 上（primitives.Input 与退化实现都是），
			// 所以 onChange 拿到的是 DOM 事件——名字要从 `event.target.value` 取。
			// 直接透传 event 会让草稿名变成对象，受控值被 React 写成 "[object Object]"。
			const nameInput = h(UiInput, {
				value: draft.name ?? '',
				placeholder: t('roles.namePlaceholder'),
				disabled: props.busy,
				onChange: (event) => props.onName(event.target.value),
			})

			const projectList = projectSkills.length === 0
				? h('span', { className: 'sc-sub' }, t('roles.noCandidates'))
				: h(
					'div',
					{ className: 'sc-role-skills' },
					projectSkills.map((skill) =>
						h(
							'label',
							{ key: skill.name, className: 'sc-role-skill', 'data-skill': skill.name },
							h(UiSwitch, {
								checked: picked.has(skill.name),
								disabled: props.busy || skill.toggleable !== true,
								label: skill.name,
								onChange: (next) => props.onToggle(skill.name, next),
							}),
							h('span', { className: 'sc-role-skill-name' }, skill.name),
							h('span', { className: 'sc-sub' }, skill.enabled ? '●' : '○'),
							skill.toggleable === true ? null : h(UiTag, { tone: 'quiet' }, readOnlyText(t, skill)),
						),
					),
				)

			const globalList = globalSkills.length === 0
				? null
				: h(
					'div',
					{ className: 'sc-role-skills' },
					globalSkills.map((skill) =>
						h(
							'div',
							{ key: skill.name, className: 'sc-role-skill sc-role-skill-readonly' },
							h('span', { className: 'sc-role-skill-name' }, skill.name),
							h('span', { className: 'sc-sub' }, skill.enabled ? '●' : '○'),
						),
					),
				)

			const missingBlock = missing.length === 0
				? null
				: h(
					'div',
					{ className: 'sc-role-missing' },
					h('span', { className: 'sc-role-missing-title' }, t('roles.missingSkills')),
					h('span', { className: 'sc-sub' }, t('roles.missingHint')),
					h('div', { className: 'sc-role-missing-list' }, missing.map((name) => h(UiTag, { key: name, tone: 'warning' }, name))),
				)

			return h(
				'div',
				{ className: 'sc-role-editor' },
				h(
					'div',
					{ className: 'sc-role-editor-head' },
					h('span', { className: 'sc-sub' }, t('roles.name')),
					nameInput,
				),
				h(
					'div',
					{ className: 'sc-group' },
					h(
						'div',
						{ className: 'sc-group-head' },
						h('span', { className: 'sc-group-title' }, t('roles.projectSkills')),
					),
					projectList,
					missingBlock,
				),
				globalList === null
					? null
					: h(
						'div',
						{ className: 'sc-group' },
						h(
							'div',
							{ className: 'sc-group-head' },
							h('span', { className: 'sc-group-title' }, t('roles.globalSkills')),
						),
						h('div', { className: 'sc-role-global-note' }, t('roles.globalReadonly')),
						globalList,
					),
				h(
					'div',
					{ className: 'sc-row-actions' },
					h(UiButton, { disabled: props.busy, onClick: props.onSave }, t('roles.save')),
					h(UiButton, { disabled: props.busy, onClick: props.onCancel }, t('roles.cancel')),
					// 还没保存的角色没有可切换的身份：先保存。别让它拿空 id 去打宿主。
					props.onActivate === null
						? h('span', { className: 'sc-sub' }, t('roles.saveFirst'))
						: h(UiButton, { disabled: props.busy, onClick: props.onActivate }, t('roles.activate')),
				),
			)
		}

		/**
		 * 角色页面本体。
		 *
		 * 对齐是**破坏性**的（会停用本项目里角色外的所有技能），所以：
		 *   - 编辑只改草稿，`保存` 只写 roles.json，不碰技能文件；
		 *   - 只有 `切换到此角色` 才落盘，而且先弹一次带数量的确认。
		 *
		 * @param props - `{t, sessionId}`。
		 */
		function RolesPanel(props) {
			const t = props.t
			const [data, setData] = react.useState(null)
			const [draft, setDraft] = react.useState(null)
			const [busy, setBusy] = react.useState(false)
			const [notice, setNotice] = react.useState(null)
			const [error, setError] = react.useState(null)

			const load = react.useCallback(() => {
				setBusy(true)
				apiGet('/roles', null, props.sessionId)
					.then((payload) => {
						setData(payload)
						setError(null)
					})
					.catch((failure) => setError(actionError(t, failure)))
					.then(() => setBusy(false))
			}, [props.sessionId, t])

			react.useEffect(() => {
				load()
			}, [load])

			if (data === null) {
				return h('div', { className: 'sc-body' }, h('span', { className: 'sc-sub' }, error ?? t('roles.loadFailed')))
			}

			const status = roleStatusOf(data)
			const roles = Array.isArray(data.roles) ? data.roles : []
			const projectName = data.project?.name ?? t('roles.noProject')
			// 0.4.0：角色里「将从全局复制进项目」的数量，以及「项目里已有同名、保留本地」的名单。
			const copyCount = Number(data.stats?.copy ?? 0)
			const localKeptList = Array.isArray(data.localKept) ? data.localKept : []

			/** 把一份角色转成草稿。 */
			const draftOf = (role) => ({ id: role.id, name: role.name, skills: [...(role.skills ?? [])] })

			const current = draft ?? { id: null, name: '', skills: [] }
			const missingInDraft = current.skills.filter((name) => !(data.candidates?.project ?? []).some((skill) => skill.name === name))

			/**
			 * 准备一份「将复制 A / 启用 M / 停用 N」的确认文案（本地算，不为了弹窗再打一次接口）。
			 * 技能名由调用方显式传入：从角色列表直接激活时并没有草稿，
			 * 若读 `current.skills`（草稿为空时是空数组）会把数量恒算成 0。
			 */
			const confirmText = (skills) => {
				const wanted = skills ?? []
				const picked = new Set(wanted)
				const projectSkills = data.candidates?.project ?? []
				const globalNames = new Set((data.candidates?.global ?? []).map((skill) => skill.name))
				const known = new Set(projectSkills.map((skill) => skill.name))
				// copy：角色里有、项目里没有、全局根里有 → 对齐时会从全局复制一份进项目
				const copy = wanted.filter((name) => !known.has(name) && globalNames.has(name)).length
				const enable = projectSkills.filter((skill) => picked.has(skill.name) && skill.enabled !== true).length
				const disable = projectSkills.filter((skill) => !picked.has(skill.name) && skill.enabled === true).length
				return t('roles.activateConfirm', { copy, enable, disable })
			}

			const runActivate = (roleId, skills) => {
				if (!askConfirm(confirmText(skills))) return
				setBusy(true)
				apiPost('/roles/activate', { id: roleId }, props.sessionId)
					.then((result) => {
						const failed = (result.results ?? []).filter((entry) => entry.ok !== true)
						const takeover = result.takeover ?? []
						// `activate` 的 data 里没有 stats，只有 results：按实际动作现算回执。
						const done = (result.results ?? []).filter((entry) => entry.ok === true)
						const copies = done.filter((entry) => entry.action === 'copy').length
						const enables = done.filter((entry) => entry.action === 'enable').length
						const disables = done.filter((entry) => entry.action === 'disable').length
						const lines = [t('roles.activateSummary', { copy: copies, enable: enables, disable: disables, skipped: failed.length })]
						for (const entry of takeover) lines.push(t('roles.takeover', { name: entry.name }))
						setNotice(lines.join('；'))
						setDraft(null)
						load()
					})
					.catch((failure) => setError(actionError(t, failure)))
					.then(() => setBusy(false))
			}

			const runSave = () => {
				setBusy(true)
				apiPost('/roles/save', { id: current.id ?? undefined, name: current.name, skills: current.skills }, props.sessionId)
					.then(() => {
						setDraft(null)
						setNotice(null)
						load()
					})
					.catch((failure) => setError(actionError(t, failure)))
					.then(() => setBusy(false))
			}

			const runRemove = (role) => {
				if (!askConfirm(t('roles.removeConfirm', { name: role.name }))) return
				setBusy(true)
				apiPost('/roles/remove', { id: role.id }, props.sessionId)
					.then(() => {
						if (draft !== null && draft.id === role.id) setDraft(null)
						load()
					})
					.catch((failure) => setError(actionError(t, failure)))
					.then(() => setBusy(false))
			}

			const runDeactivate = () => {
				if (!askConfirm(t('roles.deactivateConfirm'))) return
				setBusy(true)
				apiPost('/roles/deactivate', {}, props.sessionId)
					.then(() => {
						setDraft(null)
						load()
					})
					.catch((failure) => setError(actionError(t, failure)))
					.then(() => setBusy(false))
			}

			const toggleSkill = (name, next) => {
				const picked = new Set(current.skills)
				if (next === true) picked.add(name)
				else picked.delete(name)
				setDraft({ ...current, skills: [...picked] })
			}

			return h(
				'div',
				{ className: 'sc-body' },
				h(
					'div',
					{ className: 'sc-bar' },
					h('span', null, `${t('roles.currentProject')}：${projectName}`),
					h(UiTag, { tone: roleToneOf(status) }, t(roleStatusKey(status))),
					data.active === null || data.active === undefined ? null : h(UiTag, { tone: 'quiet' }, data.active.name),
					data.project?.fallback === true ? h(UiTag, { tone: 'warning' }, t('roles.fallback')) : null,
					copyCount > 0 ? h(UiTag, { tone: 'quiet' }, t('roles.copyCount', { count: copyCount })) : null,
					h('span', { className: 'sc-spacer' }),
					h(UiButton, { disabled: busy, onClick: () => setDraft({ id: null, name: '', skills: [] }) }, t('roles.new')),
					status === 'unassigned' ? null : h(UiButton, { disabled: busy, onClick: runDeactivate }, t('roles.deactivate')),
				),
				status === 'drifted' ? h('span', { className: 'sc-sub' }, t('roles.statusDriftedHint')) : null,
				error === null ? null : h('span', { className: 'sc-role-error' }, error),
				notice === null ? null : h('span', { className: 'sc-role-notice' }, notice),
				localKeptList.length > 0
					? h(
							'div',
							{ className: 'sc-note' },
							h('div', { className: 'sc-group-title' }, t('roles.localKept')),
							localKeptList.map((entry) => h('div', { key: 'local-kept-' + entry.name, className: 'sc-hint' }, entry.name)),
							h('div', { className: 'sc-hint' }, t('roles.localKeptHint')),
						)
					: null,
				draft !== null
					? h(RoleEditor, {
						t,
						draft: current,
						candidates: data.candidates ?? { project: [], global: [] },
						missing: missingInDraft,
						busy,
						onName: (value) => setDraft({ ...current, name: value }),
						onToggle: toggleSkill,
						onSave: runSave,
						onCancel: () => setDraft(null),
						onActivate: current.id === null ? null : () => runActivate(current.id, current.skills),
					})
					: h(
						'div',
						{ className: 'sc-group' },
						h('div', { className: 'sc-group-head' }, h('span', { className: 'sc-group-title' }, t('tab.roles'))),
						roles.length === 0
							? h('span', { className: 'sc-sub' }, t('roles.empty'))
							: roles.map((role) =>
								h(RoleRow, {
									key: role.id,
									t,
									role,
									status,
									busy,
									onActivate: () => runActivate(role.id, role.skills ?? []),
									onEdit: () => setDraft(draftOf(role)),
									onRemove: () => runRemove(role),
								}),
							),
					),
			)
		}

		/**
		 * 从 session store 的状态里取「当前会话 id」。
		 *
		 * 读法对齐本机实测可用的 @michengai/dsh-skills-manager：先取 `current`；
		 * 它为空时退回到「被主视图保留」（`retainedBy.mainView`）的那个会话。
		 * 都不行就返回 undefined——宿主会回落到它自己的默认项目，并在响应里标记
		 * `selected.fallback`，界面据此告诉用户「看的不是当前工作区」。
		 *
		 * @param state - `props.useSessions((state) => state)` 的返回值。
		 * @returns 会话 id 或 undefined。
		 */
		function sessionIdOf(state) {
			if (!state || typeof state !== 'object') return undefined
			if (typeof state.current === 'string' && state.current !== '') return state.current
			const byId = state.byId
			if (!byId || typeof byId !== 'object') return undefined
			const ids = Array.isArray(state.ids) && state.ids.length > 0 ? state.ids : Object.keys(byId)
			for (const id of ids) {
				const entry = byId[id]
				if (entry && entry.retainedBy && entry.retainedBy.mainView) return id
			}
			return undefined
		}

		/**
		 * 设置分区本体：标题 + 两个页签。
		 *
		 * 会话 id 的读法是契约的一部分，**每次渲染都要无条件调用同一个 hook**：
		 * `useSessions` 是否存在对一个挂载点来说是稳定的，所以这样调用不会违反 hook 规则。
		 * 拿不到就返回 undefined——宿主会回落到它自己的默认项目，并告诉我们。
		 */
		function SkillConsoleSection(props) {
			const t = makeT(props && props.t)
			// 无条件调用：props.useSessions 的存在性对一个挂载点是稳定的。
			const store = typeof props.useSessions === 'function' ? props.useSessions((state) => state) : undefined
			const sessionId = sessionIdOf(store)
			const [tab, setTab] = react.useState('skills')
			// 版本号来自宿主的 /state（它读的是插件自己的 package.json）。
			// 拉不到就不显示这一枚标签——配置页其余部分照常可用。
			const [version, setVersion] = react.useState('')

			react.useEffect(() => {
				let alive = true
				apiGet('/state', null, sessionId)
					.then((data) => {
						if (!alive) return
						if (data && typeof data.version === 'string') setVersion(data.version)
					})
					.catch(() => {
						// 版本号只是展示信息，读不到不值得报错。
					})
				return () => {
					alive = false
				}
			}, [sessionId])

			return h(
				'div',
				{ className: 'sc-section' },
				h(
					'div',
					{ className: 'sc-head' },
					h(
						'div',
						{ className: 'sc-bar' },
						h('span', { className: 'sc-title' }, t('section.title')),
						version === '' ? null : h(UiTag, { tone: 'quiet' }, t('section.version', { version })),
					),
					h('span', { className: 'sc-sub' }, t('section.subtitle')),
				),
				h(
					'div',
					{ className: 'sc-tabs' },
					h(UiPill, { active: tab === 'skills', onClick: () => setTab('skills'), children: t('tab.skills') }),
					h(UiPill, { active: tab === 'repos', onClick: () => setTab('repos'), children: t('tab.repos') }),
					h(UiPill, { active: tab === 'roles', onClick: () => setTab('roles'), children: t('tab.roles') }),
				),
				// 两个页签各自再包一层边界：一个页签炸了不影响另一个。
				tab === 'skills'
					? h(PanelBoundary, { key: 'skills' }, h(SkillsPanel, { t, sessionId }))
					: tab === 'repos'
						? h(PanelBoundary, { key: 'repos' }, h(ReposPanel, { t, sessionId }))
						: h(PanelBoundary, { key: 'roles' }, h(RolesPanel, { t, sessionId })),
			)
		}

		// ── 打包 / 挂载 ───────────────────────────────────────────────────────

		/** 需要的客户端服务：slots（挂载点）+ locale（词典）。 */
		const inject = ['slots', 'locale']

		/** 注入一次样式；没有 document（测试环境 / 非浏览器）就跳过。 */
		function injectStyle() {
			if (typeof document === 'undefined' || !document.head) return () => {}
			const existing = document.getElementById(STYLE_ID)
			if (existing) existing.remove()
			const style = document.createElement('style')
			style.id = STYLE_ID
			style.textContent = CSS
			document.head.appendChild(style)
			return () => {
				const current = document.getElementById(STYLE_ID)
				if (current) current.remove()
			}
		}

		/**
		 * 注册唯一挂载点：设置 →「技能控制台」。
		 *
		 * `icon: 'skill'` 是本机已装的 @michengai/dsh-skills-manager 用过的写法，
		 * 说明这个 DSH 版本的 settings.section 认这个字段；`locale: NS` 让 shell
		 * 把绑定到本命名空间的 `t` 作为 prop 注入进来。
		 */
		function apply(ctx) {
			try {
				if (ctx && ctx.locale && typeof ctx.locale.bind === 'function') {
					localeT = ctx.locale.bind(NS)
				}
				ctx.effect(() => injectStyle(), 'dsh-skill-console: styles')
				ctx.effect(() => {
					const locale = ctx && ctx.locale
					// 没有 locale 面也照常工作：所有文案都会回落到内置 zh 字典。
					if (!locale || typeof locale.register !== 'function') return () => {}
					return locale.register(NS, DICT)
				}, 'dsh-skill-console: locale')
				ctx.effect(
					() =>
						ctx.slots.inject('settings.section', () =>
							ctx.slots.register(
								{
									name: 'settings.section',
									id: 'skill-console',
									order: SECTION_ORDER,
									label: () => t('section.label'),
									icon: 'skill',
									locale: NS,
								},
								(props) => h(PanelBoundary, null, h(SkillConsoleSection, props || {})),
							),
						),
					'dsh-skill-console: settings section',
				)
			} catch (error) {
				console.error('[dsh-skill-console] 界面挂载失败：', error)
			}
		}

		exports.apply = apply
		exports.inject = inject
		// 只给测试用：这几条规则都是契约的一部分，必须能被单测直接打到。
		exports.sessionIdOf = sessionIdOf
		exports.roleStatusOf = roleStatusOf
		exports.RoleRow = RoleRow
		exports.RoleEditor = RoleEditor
		exports.sourceRepoOf = sourceRepoOf
		exports.SkillRow = SkillRow
		exports.SkillGroup = SkillGroup
		exports.RepoRow = RepoRow
		exports.RepoSkills = RepoSkills
		exports.RepoEditForm = RepoEditForm
		exports.emptyDetailKeyFor = emptyDetailKeyFor
		exports.projectOptionsOf = projectOptionsOf
		exports.projectOptionOfPick = projectOptionOfPick
		return module.exports
	},
})
