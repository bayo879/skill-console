/**
 * 「项目」维度：哪些项目可见、本次请求看的是哪个项目、这个项目能看到哪些技能根。
 *
 * 两个来源，各管一件事：
 *
 * - **列表**（`workspacesOf`）优先读 DSH 的 `workspaceRegistry` 服务：注册过的目录都在，
 *   不管它今天有没有会话。注册表拿不到时才退回「活着的会话」，并用 `from: 'sessions'` 说明。
 *   0.5.0 只看会话，于是没开过会话的工作区在界面上根本不存在——那正是要修的现场问题。
 * - **解析**（`resolveProject` / `resolveWorkspaceStrict`）只认本次请求指定的那个：
 *   目录路径（0.6.0 起的写身份）或会话 id。
 *
 * DSH 的会话带一个 `cwd`，向上找到含 `.git` 的目录就是项目根，于是项目技能根是
 * `<projectRoot>/.dsh/skills`。
 *
 * 会话多、项目少：同一个工作区每开一次会话就多一条，`cwd` 却一模一样。所以
 * `listProjects()` 按**项目根**去重——界面上「项目」指的是项目，不是会话。
 *
 * **回落的诚实性**（这是本模块最要紧的一条）：浏览器没带会话 id、或者带的会话已经
 * 不在了，就会回落到「最近一个会话」。这时必须把 `fallback: true` 明确回给界面——
 * 否则用户以为自己在管 A 项目，其实管的是 B 项目，而两条路径长得一模一样。
 */

import { basename, isAbsolute } from 'node:path'
import { statSync } from 'node:fs'

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

/**
 * 严格版：只认给定的会话，解析不出来就 null。
 *
 * 写操作必须走这条——`resolveProject` 找不到会话时会回落到「最近一个会话」，
 * 那意味着界面选着项目 B、写却落到项目 A，而且没有任何提示。
 *
 * @param ctx - 宿主上下文。
 * @param sessionId - 请求里指定的会话 id（body.project 或请求头）。
 * @returns `{sessionId, cwd, root, fallback:false}` 或 null。
 */
export function resolveProjectStrict(ctx, sessionId) {
	if (typeof sessionId !== 'string' || sessionId === '') return null
	const cwd = sessionCwd(ctx, sessionId)
	if (cwd === undefined) return null
	return { sessionId, cwd, root: findProjectRoot(cwd), fallback: false }
}

/** 本次请求可见的全部技能根（全局 + 该项目）。 */
export function rootsFor(project) {
	return resolveRoots({ dshHome: resolveDshHome(), projectCwd: project?.cwd })
}

/**
 * 工作区列表：DSH 注册表里的全部工作区（含没有会话的），注册表缺席时退回活着的会话。
 *
 * 为什么不能只看会话：没开过会话的工作区根本不在列表里，而下拉框把它当「项目」——
 * 用户看到的就是「工作区选项只剩当前那一个」。
 *
 * 读取失败**降级不改语义**：注册表抛异常、或 `list()` 没返回数组时退回会话，并且 `from`
 * 如实说 `'sessions'`，界面据此知道自己看到的是残缺列表，而不是「世界上只有这一个工作区」。
 *
 * @param ctx - 宿主上下文。
 * @returns `{from: 'registry' | 'sessions', list: [{workspaceId?, sessionId?, path, title, root, sessionIds, fromRegistry}]}`。
 */
export function workspacesOf(ctx) {
	const registry = typeof ctx?.get === 'function' ? ctx.get('workspaceRegistry', false) : undefined
	if (registry !== undefined && registry !== null && typeof registry.list === 'function') {
		let raw
		try {
			raw = registry.list()
		} catch (error) {
			raw = undefined
			ctx?.logger?.warn?.(`[dsh-skill-console] 读取工作区注册表失败：${errorText(error)}`)
		}
		// 非数组（老版本 / 被改坏的实现）等同注册表不可用：退回会话，别让 `/state` 500。
		if (Array.isArray(raw)) {
			const list = []
			for (const item of raw) {
				const workspacePath = typeof item?.path === 'string' ? item.path : ''
				if (workspacePath === '') continue
				const workspaceId = item?.id ?? item?.workspaceId
				list.push({
					workspaceId: workspaceId === undefined || workspaceId === null ? workspacePath : String(workspaceId),
					path: workspacePath,
					title: typeof item?.title === 'string' && item.title !== '' ? item.title : basename(workspacePath),
					root: findProjectRoot(workspacePath) ?? workspacePath,
					sessionIds: Array.isArray(item?.sessionIds) ? item.sessionIds.map((sessionId) => String(sessionId)) : [],
					fromRegistry: true,
				})
			}
			return { from: 'registry', list }
		}
		if (raw !== undefined) {
			ctx?.logger?.warn?.('[dsh-skill-console] 工作区注册表的 list() 没返回数组，退回活着的会话')
		}
	}
	const list = listProjects(ctx).map((entry) => ({
		sessionId: entry.sessionId,
		path: entry.cwd,
		title: basename(entry.cwd),
		root: entry.root,
		sessionIds: [],
		fromRegistry: false,
	}))
	return { from: 'sessions', list }
}

/**
 * 严格版：只认**给定的目录路径**，存在且是目录才算数。
 *
 * 写操作的 `project` 参数走这条。不要求该目录在注册表里：它今天（经会话头）本来就能用，
 * 收紧只会让杂项目录里的会话忽然写不了；而技能根仍由 `rootsFor` 限定，能力面没有变化。
 *
 * @param ctx - 宿主上下文。
 * @param dir - 工作区目录路径。
 * @returns `{path, cwd, sessionId: null, root, fallback: false}` 或 null。
 */
export function resolveWorkspaceStrict(ctx, dir) {
	if (typeof dir !== 'string' || dir === '') return null
	if (!isAbsolute(dir)) return null
	let stats = null
	try {
		stats = statSync(dir)
	} catch {
		return null
	}
	if (!stats.isDirectory()) return null
	return { path: dir, cwd: dir, sessionId: null, root: findProjectRoot(dir) ?? dir, fallback: false }
}
