/**
 * dsh-skill-console — 宿主半边（只做装配）。
 *
 * 一个设置分区背后需要的全部后端：技能目录、开启/关闭、GitHub 技能仓库订阅。
 *
 * 三条设计边界（README 里也逐条列着）：
 *
 *   1. **关技能 = 重命名发现文件**。内容一个字不改、一个文件不删。DSH 的
 *      filesystem provider 只认精确的 `SKILL.md` / `<name>.md`，所以加一个
 *      `.disabled` 后缀就等于「这个技能不存在」。想恢复就再改回来。
 *   2. **拉取 ≠ 安装**。`拉取最新` 只刷新远端清单（写 `repository-cache/`），
 *      技能目录一个字节都不动；装哪些、什么时候装，由人逐项确认。
 *   3. **安装目标可选**：缺省只写全局 DSH 技能根；显式 `target:'project'` 时才写
 *      当前项目技能根。项目技能根的启停与复制也只由用户显式点角色切换触发。
 *
 * 让 Agent 马上看到改动：本插件注册一个**空 provider**，借它的
 * `control.invalidate()` 清掉技能注册表的全量缓存（`invalidateCache()` 是
 * 注册表级的，文档见 `@deepseek-ai/dsh-skill`）。`skills/change` 没有 in-tree
 * 监听者，`dsh-tool-skill` 是在下一个 `agent/pre-step` 重新取快照的——所以
 * 「下一次工具调用就能看到」而不是「立刻推送」。
 *
 * 代码分工（本文件只连不实现）：
 *   `roots.js` 技能根/扫描/启停 · `repos.js` 仓库订阅 · `projects.js` 项目维度
 *   `routes.js` HTTP 路由 · `http.js` 围栏与响应 · `client.js` 浏览器半边
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { errorText } from './http.js'
import { createPrefixHandler } from './routes.js'
import { MAX_REPOSITORIES, createRepositoryManager, readToken } from './repos.js'
import { createRoleStore } from './roles.js'
import { resolveDshHome } from './roots.js'

/** cordis 插件名（与 cordis.patch.yml 的 insert id 对齐）。 */
export const name = 'skill-console'

/**
 * 需要的宿主服务。
 *
 * 这里只列**必需**服务：cordis 会等它们就绪才 apply，读它们不会抛。
 *
 * `webRuntime`（只有 web 部署才有 `trustedHosts`）**故意不列在这里**：
 * 一是它非必需，列为必需会让插件在没有 web-app 的部署里永远不 apply；
 * 二是「不 inject 也能安全地读」有专门的写法——见 {@link trustedHostsOf}
 * （`ctx.webRuntime?.x` 会抛，`ctx.get('webRuntime', false)` 才是可选读法）。
 */
export const inject = ['webServer', 'skills', 'sessions']

/** 路由前缀。 */
export const ROUTE_PREFIX = '/api/skill-console'

// 这两样在 http.js 里实现；从宿主入口再转一次，是为了让「宿主半边的公开面」
// （name / inject / ROUTE_PREFIX / apply 之外）对老调用方保持稳定。
export { CLIENT_HEADER, validateRequestOrigin } from './http.js'

/** Web UI 里的分区位置（排在 skill-hub、cluster-panel 之后，skills-manager 之前）。 */
export const SECTION_ORDER = 14

/** 本文件所在目录（`<pkg>/lib`）。 */
const HERE = fileURLToPath(new URL('.', import.meta.url))

/** 插件版本（`/state` 里回给界面，方便对照 README）。 */
function pluginVersion() {
	try {
		const pkg = JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8'))
		return typeof pkg.version === 'string' ? pkg.version : '0.0.0'
	} catch {
		return '0.0.0'
	}
}

/**
 * 挂载宿主半边。
 * @param ctx - 宿主上下文（webServer + skills + sessions）。
 */
export function apply(ctx) {
	const version = pluginVersion()
	const dshHome = resolveDshHome()
	const stateDir = join(dshHome, 'skill-console')
	const skillsDir = join(dshHome, 'skills')

	const log = (message) => {
		try {
			ctx.logger?.info?.(`[dsh-skill-console] ${message}`)
		} catch {
			// 记日志失败不是错误。
		}
	}

	const repositories = createRepositoryManager({ stateDir, skillsDir, log })
	const roleStore = createRoleStore({ stateDir, log })

	/**
	 * 技能注册表失效句柄。
	 *
	 * 注册一个**空 provider** 只为了拿到 `control`：`control.invalidate()` 会清掉
	 * 注册表级的目录缓存并 bump revision，这是第三方插件让运行中的 Agent
	 * 重新发现技能的公开路径。provider 落在根 ctx 的层里，但失效是注册表级的，
	 * 所以 preset 层里的那份文件系统 provider 也一起被刷新。
	 */
	let invalidateSkills = null
	const refreshSkills = () => {
		try {
			invalidateSkills?.()
		} catch (error) {
			log(`让技能注册表失效失败：${errorText(error)}`)
		}
	}
	repositories.setAfterMutation(refreshSkills)

	// provider 注册单独兜底：`skills` 服务缺位时（降级部署 / 契约变化）路由仍然要能用，
	// 代价只是「改完盘要等下一次自然失效」而不是立刻失效。
	try {
		ctx.effect(
			() =>
				ctx.skills.registerProvider((control) => {
					invalidateSkills = () => control.invalidate()
					control.signal?.addEventListener?.('abort', () => {
						invalidateSkills = null
					})
					return { name: 'skill-console', list: async () => [], get: async () => undefined }
				}),
			'dsh-skill-console: refresh provider',
		)
	} catch (error) {
		log(`注册刷新 provider 失败（启停照常生效，只是不会立刻让注册表失效）：${errorText(error)}`)
	}

	/** 改完盘之后再喊一声 `fs/observed`：让 DSH 的文件系统 watcher 立刻复核这条路径。 */
	const notifyFileChanged = (filePath) => {
		try {
			ctx.emit?.('fs/observed', { targetKey: filePath, displayPath: filePath }, { kind: 'present', version: String(Date.now()) }, { name: 'write' })
		} catch {
			// 事件面不存在（老版本 / 非 web 部署）时不算错误：invalidate 已经生效。
		}
	}

	try {
		ctx.effect(
			() =>
				ctx.webServer.register({
					kind: 'prefix',
					path: ROUTE_PREFIX,
					handler: createPrefixHandler({
						ctx,
						prefix: ROUTE_PREFIX,
						repositories,
						roleStore,
						dshHome,
						stateDir,
						skillsDir,
						version,
						refreshSkills,
						notifyFileChanged,
						tokenPresent: () => readToken() !== null,
						maxRepositories: MAX_REPOSITORIES,
					}),
				}),
			'dsh-skill-console: routes',
		)
		log(`已挂载 ${ROUTE_PREFIX}（技能根 ${skillsDir}，状态目录 ${stateDir}）`)
	} catch (error) {
		// 路由挂不上不能拖垮整个 web profile 的启动。
		console.error('[dsh-skill-console] 路由挂载失败：', errorText(error))
	}
}
