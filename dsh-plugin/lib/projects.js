/**
 * 「项目」维度：哪些项目可见、本次请求看的是哪个项目、这个项目能看到哪些技能根。
 *
 * DSH 的会话就是项目来源：每个活着的会话带一个 `cwd`，向上找到含 `.git` 的目录
 * 就是项目根，于是项目技能根是 `<projectRoot>/.dsh/skills`。
 *
 * 会话多、项目少：同一个工作区每开一次会话就多一条，`cwd` 却一模一样。所以
 * `listProjects()` 按**项目根**去重——界面上「项目」指的是项目，不是会话。
 *
 * **回落的诚实性**（这是本模块最要紧的一条）：浏览器没带会话 id、或者带的会话已经
 * 不在了，就会回落到「最近一个会话」。这时必须把 `fallback: true` 明确回给界面——
 * 否则用户以为自己在管 A 项目，其实管的是 B 项目，而两条路径长得一模一样。
 */

import { findProjectRoot, resolveDshHome, resolveRoots } from './roots.js'
import { errorText } from './http.js'

/** 拿到 sessions 服务（`ctx.sessions` 或 `ctx.get('sessions')`）。 */
function sessionsOf(ctx) {
	return ctx?.sessions ?? (typeof ctx?.get === 'function' ? ctx.get('sessions') : undefined)
}

/**
 * 活着的会话 → **项目**列表，一个项目一条。
 *
 * 会话不是项目：同一个工作区开过几次会话，`list()` 里就有几条，`cwd` 一模一样。
 * 而本插件眼里的项目是「项目根」（`findProjectRoot(cwd)`），同一仓库的不同子目录
 * 指向的也是同一份 `<项目根>/.dsh/skills`。所以这里按项目根去重——否则下拉框里
 * 会是一串长得完全一样的地址，用户根本分不清哪条是哪条。
 *
 * 每条仍带一个 `sessionId`：界面把它回传，宿主才能解析出 `cwd`。去重后必须保证
 * 「本次请求带的会话」成为它所属项目的代表，否则下拉框的当前值不在选项里，会显示成空。
 *
 * @param ctx - 宿主上下文。
 * @param options - `{preferSessionId}`：优先当代表的会话 id（本次请求带的那个）。
 * @returns `[{sessionId, cwd, root, updatedAt}]`，最近的在前。
 */
export function listProjects(ctx, options = {}) {
	const sessions = sessionsOf(ctx)
	if (sessions === undefined) return []
	let raw = []
	try {
		raw = typeof sessions.list === 'function' ? sessions.list() : []
	} catch (error) {
		ctx?.logger?.warn?.(`[dsh-skill-console] 读取会话列表失败：${errorText(error)}`)
		return []
	}
	const projects = []
	for (const session of raw ?? []) {
		const sessionId = session?.id ?? session?.header?.id
		const cwd = session?.header?.cwd
		if (typeof sessionId !== 'string' || typeof cwd !== 'string' || cwd.trim() === '') continue
		const updatedAt = Number(session?.header?.updatedAt ?? session?.header?.createdAt ?? session?.updatedAt ?? 0) || 0
		projects.push({ sessionId, cwd: cwd.trim(), updatedAt })
	}
	// 最近的在前；没有时间戳的按原顺序垫后（`list()` 本身通常已是新→旧）。
	projects.sort((a, b) => b.updatedAt - a.updatedAt)

	const preferSessionId = typeof options.preferSessionId === 'string' ? options.preferSessionId : undefined
	const byRoot = new Map()
	for (const entry of projects) {
		const projectRoot = findProjectRoot(entry.cwd) ?? entry.cwd
		if (!byRoot.has(projectRoot)) {
			byRoot.set(projectRoot, { ...entry, root: projectRoot })
			continue
		}
		// 已经有代表了：只有「本次请求带的会话」才有资格顶掉它（保持 list() 的新→旧序）。
		if (entry.sessionId === preferSessionId) byRoot.set(projectRoot, { ...entry, root: projectRoot })
	}
	return [...byRoot.values()]
}

/**
 * 一个会话 id → cwd（浏览器半边带的 `x-skill-console-session`）。
 * @returns cwd 或 undefined。
 */
export function sessionCwd(ctx, sessionId) {
	if (typeof sessionId !== 'string' || sessionId.trim() === '') return undefined
	const sessions = sessionsOf(ctx)
	if (sessions === undefined) return undefined
	try {
		const session = typeof sessions.get === 'function' ? sessions.get(sessionId) : undefined
		const cwd = session?.header?.cwd
		return typeof cwd === 'string' && cwd.trim() !== '' ? cwd.trim() : undefined
	} catch {
		return undefined
	}
}

/**
 * 解析本次请求的「项目」。
 * @param ctx - 宿主上下文。
 * @param sessionId - 客户端带的会话 id（可为 undefined）。
 * @returns `{sessionId, cwd, root, fallback}` 或 null。
 */
export function resolveProject(ctx, sessionId) {
	const fromHeader = sessionCwd(ctx, sessionId)
	if (fromHeader !== undefined) {
		return { sessionId, cwd: fromHeader, root: findProjectRoot(fromHeader), fallback: false }
	}
	const first = listProjects(ctx)[0]
	if (first === undefined) return null
	return { sessionId: first.sessionId, cwd: first.cwd, root: findProjectRoot(first.cwd), fallback: true }
}

/** 本次请求可见的全部技能根（全局 + 该项目）。 */
export function rootsFor(project) {
	return resolveRoots({ dshHome: resolveDshHome(), projectCwd: project?.cwd })
}
