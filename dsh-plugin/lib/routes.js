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
 *
 * 破坏性动作（删除技能 / 移动到项目）由本层编排：**先备份 → 备份成功才动盘**，
 * 备份失败一律 500 `error.delete.backup`，一个字节都不改；路径语义与围栏仍在 `roots.js`。
 */

import { basename } from 'node:path'

import { copySkillIntoRoot, findCollisions, planRemoval, readSkill, removeSkill, scanRoot, toggleSkill } from './roots.js'
import { applyRole, planRole } from './roles.js'
import { CLIENT_HEADER, errorText, httpError, readJsonBody, trustedHostsOf, validateMutation, validateRequestOrigin, writeJson } from './http.js'
import { resolveProject, resolveProjectStrict, resolveWorkspaceStrict, rootsFor, workspacesOf } from './projects.js'

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
	 * 写请求的工作区：`body.project` 是**目录路径**，给了就只认它；没给才退回请求头会话。
	 *
	 * 「没给」只认 `undefined` / `null` / `''`（界面没选工作区时发的就是空串）。给了别的类型
	 * （数字、对象…）同样是「指定了认不出的工作区」，一并 400——绝不能因为类型不对就当成
	 * 「没给」而悄悄写回请求头会话，那正是 0.6.0 要杀的失败模式。
	 *
	 * 两条路都严格：解析不出来就 400，绝不悄悄写到别的工作区去。`code` 用来区分
	 * 「给的路径无效」与「没给路径、会话也认不出」——界面按码翻译。
	 */
	const projectOfRequest = (req, body) => {
		const raw = body === null || body === undefined ? undefined : body.project
		const absent = raw === undefined || raw === null || raw === ''
		if (!absent && typeof raw !== 'string') {
			return { project: null, roots: [], code: 'error.workspace.invalid' }
		}
		if (typeof raw === 'string' && raw !== '') {
			const project = resolveWorkspaceStrict(ctx, raw)
			return { project, roots: project === null ? [] : rootsFor(project), code: 'error.workspace.invalid' }
		}
		const project = resolveProjectStrict(ctx, req.headers['x-skill-console-session'])
		return { project, roots: project === null ? [] : rootsFor(project), code: 'error.role.noProject' }
	}

	/** 项目 + 三个根的收口：读路径宽松、写路径严格，最后都落到这里。 */
	const rolePartsFor = (project, roots) => ({
		project,
		projectRoot: roots.find((root) => root.key === 'project-dsh') ?? null,
		globalRoot: roots.find((root) => root.key === 'user-dsh') ?? null,
		roots,
	})

	/** 读请求的工作区：显式参数是目录路径（给错就 400），没给时才退回请求头会话。 */
	const readProjectOfRequest = (req, url) => {
		const given = url === undefined ? '' : (url.searchParams.get('project') ?? '')
		if (given !== '') {
			const project = resolveWorkspaceStrict(ctx, given)
			if (project === null) throw httpError(400, 'error.workspace.invalid', '工作区路径无效')
			return { project, roots: rootsFor(project) }
		}
		return contextOf(req.headers['x-skill-console-session'])
	}

	/** 读请求的工作区 + 三个根。 */
	const readRoleContextOfRequest = (req, url) => {
		const { project, roots } = readProjectOfRequest(req, url)
		return rolePartsFor(project, roots)
	}

	/** 写路径：项目只认请求里指定的那个。 */
	const roleContextOfRequest = (req, body) => {
		const { project, roots, code } = projectOfRequest(req, body)
		return { ...rolePartsFor(project, roots), code }
	}

	/** 项目根当前扫描到的技能（项目根不存在时是空表）。 */
	const projectSkillsOf = (projectRoot) => (projectRoot === null ? [] : scanRoot(projectRoot).skills)

	/** 内部角色 → 回给界面的形状。 */
	const publicRole = (role, activeId) => ({ id: role.id, name: role.name, skills: [...role.skills], updatedAt: role.updatedAt, active: role.id === activeId })

	/**
	 * 候选技能：项目根和全局根**同形状**，都能勾。
	 *
	 * 勾上全局候选不是「控制全局技能」，而是「切换时把全局那份复制进项目」——
	 * 所以这里没有 readOnly/reason 之类的话术，能不能动只看 `toggleable`
	 * （软链是 false，`readOnlyReason` 说明原因）。
	 */
	const candidateOf = (skill) => ({
		name: skill.name,
		path: skill.path,
		enabled: skill.enabled === true,
		toggleable: skill.toggleable === true,
		readOnlyReason: skill.readOnlyReason ?? null,
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
			const sessionId = req.headers['x-skill-console-session']
			const project = resolveProject(ctx, sessionId)
			const workspaces = workspacesOf(ctx)
			// 认领当前会话落在哪条工作区上：先按**目录路径**，再退回项目根。
			// 只按项目根认领的话，同一个仓库里的多个工作区（`repo/packages/a`、`repo/packages/b`）
			// 根相同，永远认到注册表里的第一条。
			const matched = project === null
				? undefined
				: (workspaces.list.find((entry) => entry.path === project.cwd)
					?? workspaces.list.find((entry) => entry.root === project.root))
			return {
				version,
				dshHome,
				stateDir,
				skillsDir,
				token: deps.tokenPresent(),
				roots: rootsFor(project).map(publicRoot),
				workspaces: workspaces.list,
				workspacesFrom: workspaces.from,
				selected: project === null ? null : { ...project, workspaceId: matched === undefined ? null : matched.workspaceId },
				maxRepositories: deps.maxRepositories,
			}
		},

		async catalog(req, url) {
			const scope = url.searchParams.get('scope') === 'project' ? 'project' : 'global'
			const { project, roots } = readProjectOfRequest(req, url)
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
			const { roots } = readProjectOfRequest(req, url)
			const skill = readSkill(path, { roots, withBody: true })
			return { ...skill, installed: repositories.installedIndex().get(skill.name) ?? null }
		},

		async toggle(req) {
			const body = await readJsonBody(req)
			const path = typeof body.path === 'string' ? body.path : ''
			if (path === '') throw httpError(400, 'error.proto.missingPath', '缺少 path')
			const enabled = body.enabled === true
			const { project, roots, code } = roleContextOfRequest(req, body)
			if (project === null) throw httpError(400, code, '解析不出项目技能根，无法启停')
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
			const { project, roots, code } = roleContextOfRequest(req, body)
			if (project === null) throw httpError(400, code, '解析不出项目技能根，无法批量启停')
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
			// target 只认 'project'，其余（含缺省）一律 global —— 向后兼容，也避免新增错误码。
			const target = body.target === 'project' ? 'project' : 'global'
			let targetSkillsDir
			if (target === 'project') {
				const { project, projectRoot, code } = roleContextOfRequest(req, body)
				if (project === null || projectRoot === null) throw httpError(400, code, '解析不出项目技能根，无法装到项目')
				targetSkillsDir = projectRoot.path
			}
			return repositories.install({ id, skills: body.skills.map(String), confirm: body.confirm === true, targetSkillsDir })
		},

		async roles(req, url) {
			const { project, projectRoot, globalRoot } = readRoleContextOfRequest(req, url)
			const activeRole = activeRoleOf(project)
			const projectSkills = projectSkillsOf(projectRoot)
			// 全局扫描结果一身二用：既是复制来源（sources），又是候选名单；别扫两遍。
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
					project: projectSkills.map((skill) => candidateOf(skill)),
					global: globalSkills.map((skill) => candidateOf(skill)),
				},
			}
		},

		async rolesPreview(req, url) {
			const roleId = url.searchParams.get('role')
			if (roleId === null || roleId.trim() === '') throw httpError(400, 'error.proto.missingId', '缺少 role 参数')
			const role = roleStore.get(roleId)
			if (role === null) throw httpError(404, 'error.role.unknown', `没有这个角色：${roleId}`)
			const { projectRoot, globalRoot } = readRoleContextOfRequest(req, url)
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
			const { project, projectRoot, globalRoot, roots, code } = roleContextOfRequest(req, body)
			if (project === null || projectRoot === null) throw httpError(400, code, '解析不出项目根，无法切换角色')
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
			const body = await readJsonBody(req)
			const { project, code } = roleContextOfRequest(req, body)
			if (project === null) throw httpError(400, code, '解析不出项目根，无法取消角色')
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

		/** 删除一个技能：先整份备份，备份成功才动盘（失败 500 `error.delete.backup`）。 */
		async skillsDelete(req) {
			const body = await readJsonBody(req)
			const filePath = String(body.path ?? '')
			if (filePath === '') throw httpError(400, 'error.proto.missingPath', '缺少 path')
			const { project, roots: visibleRoots, code } = roleContextOfRequest(req, body)
			if (project === null) throw httpError(400, code, '解析不出项目技能根，无法删除')
			const removal = planRemoval(visibleRoots, filePath)
			// 先备份；备份失败一个字节都不删。
			let backup
			try {
				backup = repositories.backupSkill({ name: removal.name, target: removal.backupTarget, kind: removal.backupKind })
			} catch (error) {
				throw httpError(500, 'error.delete.backup', `备份失败，技能一个字节都没删：${errorText(error)}`)
			}
			const { removed, changed } = removeSkill(removal)
			if (changed) {
				refreshSkills()
				notifyFileChanged(removal.path)
			}
			return {
				name: removal.name,
				path: removal.path,
				kind: removal.kind,
				form: removal.form,
				root: removal.root,
				directory: removal.directory,
				backup,
				removed,
				deleted: changed,
			}
		},

		/** 把全局技能根里的一个技能搬到当前项目技能根：先复制，复制成功后再删全局。 */
		async skillsMoveToProject(req) {
			const body = await readJsonBody(req)
			const filePath = String(body.path ?? '')
			if (filePath === '') throw httpError(400, 'error.proto.missingPath', '缺少 path')
			const { project, projectRoot, globalRoot, roots: visibleRoots, code } = roleContextOfRequest(req, body)
			if (project === null || projectRoot === null) throw httpError(400, code, '解析不出项目技能根，无法移动')
			const removal = planRemoval(visibleRoots, filePath)
			// `planRemoval` 的 `root` 是根的 **key 字符串**（见 roots.js 的 readSkill），不是根对象。
			if (removal.root !== 'user-dsh') throw httpError(400, 'error.transfer.notGlobal', `只能把全局技能移到项目：${removal.path}`)
			if (removal.form === 'symlink') throw httpError(400, 'error.transfer.symlink', `软链接技能不允许移动（会动到链接目标）：${removal.path}`)
			const source = readSkill(removal.path, { roots: visibleRoots })
			// 「同名」一律按**技能名**判，不按目标路径判：项目里那份可能是扁平 `X.md`，
			// 而源是目录包 `X/`，只比 `targetPathFor()` 会漏判，结果同一个名字两个副本。
			if (scanRoot(projectRoot).skills.some((entry) => entry.name === source.name)) {
				throw httpError(409, 'error.transfer.exists', `项目里已有同名技能，拒绝覆盖：${source.name}`)
			}
			let backup
			try {
				backup = repositories.backupSkill({ name: removal.name, target: removal.backupTarget, kind: removal.backupKind })
			} catch (error) {
				throw httpError(500, 'error.delete.backup', `备份失败，什么都没移动：${errorText(error)}`)
			}
			const copied = copySkillIntoRoot(projectRoot, source)
			let globalRemoved = true
			let warning
			try {
				removeSkill(removal)
			} catch (error) {
				// 不回滚：项目里那份已经就位，如实报告全局没删掉，让用户再点一次「删除」。
				globalRemoved = false
				warning = `项目里已经就位，但全局那份没删掉：${errorText(error)}`
			}
			refreshSkills()
			notifyFileChanged(copied.path)
			if (globalRemoved) notifyFileChanged(removal.path)
			return {
				name: copied.name,
				from: globalRoot === null ? null : globalRoot.path,
				to: projectRoot.path,
				kind: source.kind,
				backup,
				globalRemoved,
				...(warning === undefined ? {} : { warning }),
			}
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
	'/skills/delete': 'skillsDelete',
	'/skills/move-to-project': 'skillsMoveToProject',
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
