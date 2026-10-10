/**
 * HTTP 路由：请求 → handler → JSON。
 *
 * 一次请求的固定流程（顺序不能换）：
 *   1. 回环 / 可信 Host 围栏（`validateRequestOrigin`，在最前面，越权请求不进业务）
 *   2. 按方法和路径找 handler（未知路由 404；未知方法 405）
 *   3. 写操作额外校验「客户端标记 + JSON content-type」（`validateMutation`）
 *   4. 跑 handler，统一成 `{ok:true,data}` / `{ok:false,code,error}` 两种壳
 *
 * 错误壳里的 `code` 是**机器读的**（界面按码翻译），`error` 是给人看的中文兜底。
 * handler 抛的 `httpError(statusCode, code)` 直接决定状态码；其他异常一律 500。
 */

import { basename } from 'node:path'

import { scanRoot, toggleSkill, readSkill, findCollisions } from './roots.js'
import { applyRole, planRole } from './roles.js'
import { CLIENT_HEADER, errorText, httpError, readJsonBody, trustedHostsOf, validateMutation, validateRequestOrigin, writeJson } from './http.js'
import { listProjects, resolveProject, rootsFor } from './projects.js'

/** 批量启停 / 批量安装的上限（一次请求别把界面卡死）。 */
export const MAX_BATCH = 200

/** 去掉根描述里的 rank（前端不需要，也避免它被当成优先级去用）。 */
function publicRoot(root) {
	return { key: root.key, scope: root.scope, label: root.label, path: root.path, exists: root.exists, writable: root.writable }
}

/** 关掉某一份之后，同名技能里还有谁在生效——界面要把这句话讲出来。 */
function takeoverFor(roots, name, excludePath) {
	const others = []
	for (const root of roots) {
		if (!root.exists) continue
		const { skills } = scanRoot(root)
		for (const skill of skills) {
			if (skill.name !== name || !skill.enabled) continue
			if (excludePath !== undefined && skill.path === excludePath) continue
			others.push({ root: root.key, label: root.label, scope: root.scope, path: skill.path })
		}
	}
	return others
}

/**
 * 建全部 handler。
 * @param deps - `{ctx, repositories, roleStore, dshHome, stateDir, skillsDir, version, refreshSkills, notifyFileChanged}`。
 * @returns handler 表。
 */
export function createRouteHandlers(deps) {
	const { ctx, repositories, dshHome, stateDir, skillsDir, version, refreshSkills, notifyFileChanged, roleStore } = deps

	/** 本次请求的项目 + 技能根（每个 handler 都要用，收口在一处）。 */
	const contextOf = (sessionId) => {
		const project = resolveProject(ctx, sessionId)
		return { project, roots: rootsFor(project) }
	}

	/**
	 * 本次请求的项目 + 项目技能根 + 全局技能根。
	 *
	 * 角色这条线上**只有这里**能同时看见两个根：全局根只用来「展示 + 报告接管」，
	 * 绝不会被传进 `applyRole`（它只接受单个根）。
	 */
	const roleContextOf = (sessionId) => {
		const { project, roots } = contextOf(sessionId)
		return {
			project,
			projectRoot: roots.find((root) => root.key === 'project-dsh') ?? null,
			globalRoot: roots.find((root) => root.key === 'user-dsh') ?? null,
			roots,
		}
	}

	/** 项目根当前扫描到的技能（项目根不存在时是空表）。 */
	const projectSkillsOf = (projectRoot) => (projectRoot === null ? [] : scanRoot(projectRoot).skills)

	/** 内部角色 → 回给界面的形状。 */
	const publicRole = (role, activeId) => ({ id: role.id, name: role.name, skills: [...role.skills], updatedAt: role.updatedAt, active: role.id === activeId })

	/** 候选技能：项目根可勾选，全局根只读展示。 */
	const candidateOf = (skill, global) => ({
		name: skill.name,
		path: skill.path,
		enabled: skill.enabled === true,
		toggleable: skill.toggleable === true,
		readOnlyReason: skill.readOnlyReason ?? null,
		...(global ? { readOnly: true, reason: 'global-uncontrollable' } : {}),
	})

	/** 这个项目当前激活的角色（没有就 null）。 */
	const activeRoleOf = (project) => {
		if (project === null) return null
		const roleId = roleStore.activeFor(project.root)
		return roleId === null ? null : roleStore.get(roleId)
	}

	/** 对齐状态：无角色 → unassigned；无动作 → matched；有动作 → drifted。 */
	const statusOf = (activeRole, plan) => {
		if (activeRole === null) return 'unassigned'
		return plan !== null && plan.steps.length > 0 ? 'drifted' : 'matched'
	}

	return {
		async state(req) {
			const project = resolveProject(ctx, req.headers['x-skill-console-session'])
			return {
				version,
				dshHome,
				stateDir,
				skillsDir,
				token: deps.tokenPresent(),
				roots: rootsFor(project).map(publicRoot),
				projects: listProjects(ctx, { preferSessionId: req.headers['x-skill-console-session'] }),
				selected: project,
				maxRepositories: deps.maxRepositories,
			}
		},

		async catalog(req, url) {
			const scope = url.searchParams.get('scope') === 'project' ? 'project' : 'global'
			const { project, roots } = contextOf(url.searchParams.get('project') ?? req.headers['x-skill-console-session'])
			const installed = repositories.installedIndex()
			const warnings = []
			// 扫全部四个根（不只是当前筛选的那个）：覆盖关系要在全集上算，
			// 否则「项目副本压住全局副本」这件最该讲清楚的事会被筛选藏掉。
			const scanned = roots.map((root) => {
				const { skills, warning } = scanRoot(root)
				if (warning !== null) warnings.push(warning)
				return { ...root, skills }
			})
			const rows = scanned
				.filter((root) => root.scope === scope)
				.map((root) => ({
					...publicRoot(root),
					skills: root.skills.map((skill) => ({ ...skill, installed: installed.get(skill.name) ?? null })),
				}))
			return { scope, project: scope === 'project' ? project : null, roots: rows, collisions: findCollisions(scanned), warnings }
		},

		async skill(req, url) {
			const path = url.searchParams.get('path')
			if (path === null || path.trim() === '') throw httpError(400, 'error.proto.missingPath', '缺少 path 参数')
			const sessionId = url.searchParams.get('project') ?? req.headers['x-skill-console-session']
			const skill = readSkill(path, { roots: rootsFor(resolveProject(ctx, sessionId)), withBody: true })
			return { ...skill, installed: repositories.installedIndex().get(skill.name) ?? null }
		},

		async toggle(req) {
			const body = await readJsonBody(req)
			const path = typeof body.path === 'string' ? body.path : ''
			if (path === '') throw httpError(400, 'error.proto.missingPath', '缺少 path')
			const enabled = body.enabled === true
			const { roots } = contextOf(req.headers['x-skill-console-session'])
			const result = toggleSkill(roots, path, enabled)
			if (result.changed) {
				refreshSkills()
				notifyFileChanged(result.path)
			}
			const skill = readSkill(result.path, { roots })
			return {
				skill: { ...skill, installed: repositories.installedIndex().get(skill.name) ?? null },
				// 关掉这一份之后，同名技能里还有谁在生效——界面要把这句话讲出来。
				takeover: enabled ? [] : takeoverFor(roots, skill.name, result.path),
				changed: result.changed,
			}
		},

		async toggleBatch(req) {
			const body = await readJsonBody(req)
			const items = Array.isArray(body.items) ? body.items.slice(0, MAX_BATCH) : []
			if (items.length === 0) throw httpError(400, 'error.proto.missingItems', '缺少 items')
			const { roots } = contextOf(req.headers['x-skill-console-session'])
			const results = []
			let changed = 0
			for (const item of items) {
				const path = typeof item?.path === 'string' ? item.path : ''
				try {
					if (path === '') throw httpError(400, 'error.proto.missingPath', '缺少 path')
					const outcome = toggleSkill(roots, path, item.enabled === true)
					if (outcome.changed) {
						changed += 1
						notifyFileChanged(outcome.path)
					}
					results.push({ path, ok: true, enabled: outcome.enabled, changed: outcome.changed })
				} catch (error) {
					// 逐项报告：批量里坏了一个不该让其他项的结果丢掉。
					results.push({ path, ok: false, error: errorText(error), code: error?.code ?? 'error.unknown' })
				}
			}
			if (changed > 0) refreshSkills()
			return { results, changed }
		},

		async repositories() {
			return repositories.list()
		},

		async repositoryDetail(req, url) {
			const id = url.searchParams.get('id')
			if (id === null || id.trim() === '') throw httpError(400, 'error.proto.missingId', '缺少 id')
			return repositories.detail(id)
		},

		async repositoryAdd(req) {
			const body = await readJsonBody(req)
			return repositories.add({ url: body.url, ref: body.ref, subdirectory: body.subdirectory })
		},

		async repositoryUpdate(req) {
			const body = await readJsonBody(req)
			const id = String(body.id ?? '')
			if (id === '') throw httpError(400, 'error.proto.missingId', '缺少 id')
			return repositories.update({ id, ref: body.ref, subdirectory: body.subdirectory })
		},

		async repositoryRemove(req) {
			const body = await readJsonBody(req)
			return repositories.remove(String(body.id ?? ''))
		},

		async repositoryFetch(req) {
			const body = await readJsonBody(req)
			const id = String(body.id ?? '')
			if (id === '') throw httpError(400, 'error.proto.missingId', '缺少 id')
			const { record, manifest } = await repositories.fetch(id)
			const detail = repositories.detail(id)
			return { repository: detail.repository, skills: detail.skills, commit: manifest?.commit ?? record.lastFetch?.commit ?? null }
		},

		async repositoryInstall(req) {
			const body = await readJsonBody(req)
			const id = String(body.id ?? '')
			if (id === '') throw httpError(400, 'error.proto.missingId', '缺少 id')
			if (!Array.isArray(body.skills) || body.skills.length === 0) {
				throw httpError(400, 'error.proto.missingSkills', 'skills 必须是非空数组')
			}
			if (body.skills.length > MAX_BATCH) throw httpError(400, 'error.proto.tooMany', `一次最多处理 ${MAX_BATCH} 个技能`)
			return repositories.install({ id, skills: body.skills.map(String), confirm: body.confirm === true })
		},

		async roles(req, url) {
			const sessionId = url.searchParams.get('project') ?? req.headers['x-skill-console-session']
			const { project, projectRoot, globalRoot } = roleContextOf(sessionId)
			const activeRole = activeRoleOf(project)
			const projectSkills = projectSkillsOf(projectRoot)
			// 全局扫描结果一身二用：既是复制来源（sources），又是只读候选；别扫两遍。
			const globalSkills = globalRoot === null ? [] : scanRoot(globalRoot).skills
			const plan = activeRole === null ? null : planRole({ role: activeRole, skills: projectSkills, sources: globalSkills })
			const stats = plan === null
				? { inRole: 0, total: projectSkills.length, copy: 0, enable: 0, disable: 0, noop: 0, skipped: 0, missing: 0, localKept: 0 }
				: { inRole: activeRole.skills.length, ...plan.stats, localKept: plan.localKept.length }
			return {
				roles: roleStore.list().map((role) => publicRole(role, activeRole?.id ?? null)),
				active: activeRole === null ? null : { id: activeRole.id, name: activeRole.name },
				project: project === null ? null : { name: basename(project.root), fallback: project.fallback === true },
				status: statusOf(activeRole, plan),
				stats,
				localKept: plan === null ? [] : plan.localKept,
				candidates: {
					project: projectSkills.map((skill) => candidateOf(skill, false)),
					global: globalSkills.map((skill) => candidateOf(skill, true)),
				},
			}
		},

		async rolesPreview(req, url) {
			const roleId = url.searchParams.get('role')
			if (roleId === null || roleId.trim() === '') throw httpError(400, 'error.proto.missingId', '缺少 role 参数')
			const role = roleStore.get(roleId)
			if (role === null) throw httpError(404, 'error.role.unknown', `没有这个角色：${roleId}`)
			const sessionId = url.searchParams.get('project') ?? req.headers['x-skill-console-session']
			const { projectRoot, globalRoot } = roleContextOf(sessionId)
			// 预览必须和切换看到同一份事实，所以同样传 sources。
			const plan = planRole({ role, skills: projectSkillsOf(projectRoot), sources: globalRoot === null ? [] : scanRoot(globalRoot).skills })
			return { role: { id: role.id, name: role.name }, status: plan.steps.length > 0 ? 'drifted' : 'matched', ...plan }
		},

		async rolesSave(req) {
			const body = await readJsonBody(req)
			const role = roleStore.upsert({
				id: typeof body.id === 'string' && body.id !== '' ? body.id : undefined,
				name: body.name,
				skills: body.skills,
			})
			return { role: { id: role.id, name: role.name, skills: role.skills, updatedAt: role.updatedAt } }
		},

		async rolesRemove(req) {
			const body = await readJsonBody(req)
			const id = String(body.id ?? '')
			if (id === '') throw httpError(400, 'error.proto.missingId', '缺少 id')
			return roleStore.remove(id)
		},

		async rolesActivate(req) {
			const body = await readJsonBody(req)
			const id = String(body.id ?? '')
			if (id === '') throw httpError(400, 'error.proto.missingId', '缺少 id')
			const role = roleStore.get(id)
			if (role === null) throw httpError(404, 'error.role.unknown', `没有这个角色：${id}`)
			const { project, projectRoot, globalRoot, roots } = roleContextOf(req.headers['x-skill-console-session'])
			if (project === null || projectRoot === null) throw httpError(400, 'error.role.noProject', '解析不出项目根，无法切换角色')
			// 全局扫描结果只当复制来源；它不会进 applyRole（那边只收 projectRoot）。
			const plan = planRole({ role, skills: projectSkillsOf(projectRoot), sources: globalRoot === null ? [] : scanRoot(globalRoot).skills })
			const { results, changed } = applyRole(projectRoot, plan)
			if (changed > 0) {
				refreshSkills()
				for (const result of results) {
					if (result.ok === true && result.changed === true) notifyFileChanged(result.path)
				}
			}
			roleStore.setActive(project.root, role.id)
			// 停用之后同名技能里还有谁在生效——界面要把这件事讲出来。
			const takeover = []
			for (const step of plan.steps) {
				if (step.action !== 'disable') continue
				const others = takeoverFor(roots, step.name, undefined)
				if (others.length > 0) takeover.push({ name: step.name, by: others })
			}
			const failed = results.filter((result) => result.ok !== true).length
			return {
				role: { id: role.id, name: role.name },
				status: failed === 0 ? 'matched' : 'drifted',
				results,
				changed,
				takeover,
				localKept: plan.localKept,
			}
		},

		async rolesDeactivate(req) {
			const { project } = roleContextOf(req.headers['x-skill-console-session'])
			if (project === null) throw httpError(400, 'error.role.noProject', '解析不出项目根，无法取消角色')
			return { cleared: roleStore.clearActive(project.root) }
		},

		async backups(req, url) {
			const name = url.searchParams.get('name')
			return repositories.backups(name === null || name === '' ? undefined : name)
		},

		async restore(req) {
			const body = await readJsonBody(req)
			const skillName = String(body.name ?? '')
			if (skillName === '') throw httpError(400, 'error.proto.missingName', '缺少 name')
			return repositories.restore({ name: skillName, backup: body.backup === undefined ? undefined : String(body.backup) })
		},
	}
}

/** 把 handler 的返回/异常统一成 HTTP。 */
async function dispatch(handler, req, res, url) {
	try {
		writeJson(res, 200, { ok: true, data: await handler(req, url) })
	} catch (error) {
		writeJson(res, Number.isInteger(error?.statusCode) ? error.statusCode : 500, {
			ok: false,
			...(error?.code ? { code: error.code } : {}),
			error: errorText(error),
		})
	}
}

/** 路由表：路径 → handler 名（显式列出，别用字符串变换猜，否则改名会静默 404）。 */
const READ_ROUTES = {
	'/state': 'state',
	'/catalog': 'catalog',
	'/skill': 'skill',
	'/repositories': 'repositories',
	'/repositories/detail': 'repositoryDetail',
	'/backups': 'backups',
	'/roles': 'roles',
	'/roles/preview': 'rolesPreview',
}
const WRITE_ROUTES = {
	'/toggle': 'toggle',
	'/toggle-batch': 'toggleBatch',
	'/repositories/add': 'repositoryAdd',
	'/repositories/update': 'repositoryUpdate',
	'/repositories/remove': 'repositoryRemove',
	'/repositories/fetch': 'repositoryFetch',
	'/repositories/install': 'repositoryInstall',
	'/restore': 'restore',
	'/roles/save': 'rolesSave',
	'/roles/remove': 'rolesRemove',
	'/roles/activate': 'rolesActivate',
	'/roles/deactivate': 'rolesDeactivate',
}

/**
 * 建一个 `webServer.register({kind:'prefix'})` 用的 handler。
 * @param deps - 同 `createRouteHandlers`，外加 `{prefix}`。
 * @returns `(req, res) => Promise<void>`。
 */
export function createPrefixHandler(deps) {
	const handlers = createRouteHandlers(deps)
	const table = {}
	for (const [route, name] of Object.entries(READ_ROUTES)) table[route] = { write: false, handler: handlers[name] }
	for (const [route, name] of Object.entries(WRITE_ROUTES)) table[route] = { write: true, handler: handlers[name] }

	return async (req, res) => {
		try {
			await handleRequest(req, res, { deps, table })
		} catch (error) {
			// 最后一道兜底。宿主 webserver 对「handler 抛异常」的反应是回一个
			// **没有正文的 400**，浏览器面板只能显示「接口没挂上」——第 245 行那次
			// 现场事故就是这么藏起来的。所以这里保证：无论抛什么，客户端拿到的
			// 都是带 code 的 JSON 壳（`writeJson` 自己也带 try/catch，不会二次抛）。
			writeJson(res, 500, { ok: false, code: 'error.internal', error: errorText(error) })
		}
	}
}

/** 单次请求的实际分发（拆出来是为了让上面那层兜底只做一件事）。 */
async function handleRequest(req, res, { deps, table }) {
	const trustedHosts = trustedHostsOf(deps.ctx)
	const hostError = validateRequestOrigin(req, trustedHosts)
	if (hostError !== null) {
		writeJson(res, hostError.statusCode, { ok: false, code: hostError.code, error: hostError.error })
		return
	}
	const url = new URL(req.url ?? '/', 'http://localhost')
	const route = url.pathname.slice(deps.prefix.length).replace(/\/+$/, '') || '/'
	const method = req.method ?? 'GET'
	const entry = table[route]
	if (entry === undefined) {
		writeJson(res, 404, { ok: false, code: 'error.proto.unknownRoute', error: `未知路由：${route}` })
		return
	}
	if (entry.write === false) {
		if (method !== 'GET' && method !== 'HEAD') {
			writeJson(res, 405, { ok: false, code: 'error.proto.method', error: `不支持的方法：${method}` })
			return
		}
		await dispatch(entry.handler, req, res, url)
		return
	}
	if (method !== 'POST') {
		writeJson(res, 405, { ok: false, code: 'error.proto.method', error: `不支持的方法：${method}` })
		return
	}
	const mutationError = validateMutation(req)
	if (mutationError !== null) {
		writeJson(res, mutationError.statusCode, { ok: false, code: mutationError.code, error: mutationError.error })
		return
	}
	await dispatch(entry.handler, req, res, url)
}

// 写操作必须带这个头（跨站表单伪造不出自定义头），在 http.js 里定义。
export { CLIENT_HEADER }
