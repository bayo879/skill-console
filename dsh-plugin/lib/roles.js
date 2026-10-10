/**
 * 角色（技能组合）：持久化、切换计划、切换执行。
 *
 * 职责边界（刻意与 roots.js 分开）：
 *   - 本文件**不认识** SKILL.md 长什么样：扫描与重命名一律委托 roots.js；
 *   - 本文件唯一碰的文件是 `<stateDir>/roles.json`。
 *
 * 三条规矩：
 *   1. 状态文件损坏时**拒绝一切写入**，把错误抛出去，而不是拿一份空状态覆盖掉
 *      用户磁盘上那份可能只是手抖写坏、但还能救的文件（与 store.js 同规则）。
 *   2. 写盘**原子替换**：写 `.tmp-<uuid>` 再 rename。
 *   3. `applyRole` 只接收**单个根**（项目根）。全局根根本不进入这条链路——
 *      「不修改全局」是结构保证，不是一句 if。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

import { httpError } from './http.js'
import { toggleSkill } from './roots.js'

/** 角色数上限。 */
export const MAX_ROLES = 50
/** 单个角色的技能数上限（与 routes.js 的 MAX_BATCH 对齐）。 */
export const MAX_ROLE_SKILLS = 200
/** 角色状态文件损坏时的错误码。 */
export const ROLE_STATE_ERROR = 'error.role.state'
/** 角色名长度上限。 */
const MAX_NAME_LENGTH = 60

/** 本地错误文本（这里不需要 HTTP 语义）。 */
function errorTextOf(error) {
	return error instanceof Error ? error.message : String(error)
}

/** 空白视为未设置。 */
function blank(value) {
	return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** 只留下认识的字段，其余一律丢掉（形状漂移不会污染内存状态）。 */
function normalizeRole(raw) {
	if (raw === null || typeof raw !== 'object') return null
	const id = blank(raw.id)
	const name = blank(raw.name)
	if (id === undefined || name === undefined) return null
	const skills = Array.isArray(raw.skills) ? raw.skills.filter((entry) => typeof entry === 'string' && entry !== '') : []
	return {
		id,
		name,
		skills,
		createdAt: Number(raw.createdAt) || 0,
		updatedAt: Number(raw.updatedAt) || 0,
	}
}

/**
 * 建角色状态存储。
 * @param options - `{stateDir, log}`。
 * @returns `{load, save, list, get, upsert, remove, activeFor, setActive, clearActive, stateFile}`。
 */
export function createRoleStore(options) {
	const stateDir = options.stateDir
	const log = typeof options.log === 'function' ? options.log : () => {}
	const stateFile = join(stateDir, 'roles.json')
	let state = null

	/** 读一次状态（有缓存）。损坏时抛，绝不覆盖。 */
	function load() {
		if (state !== null) return state
		mkdirSync(stateDir, { recursive: true })
		if (!existsSync(stateFile)) {
			state = { version: 1, roles: [], active: {} }
			return state
		}
		let parsed
		try {
			parsed = JSON.parse(readFileSync(stateFile, 'utf8'))
		} catch (error) {
			throw httpError(500, ROLE_STATE_ERROR, `角色状态文件不是合法 JSON，已拒绝覆盖：${stateFile}（${errorTextOf(error)}）`)
		}
		if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.roles)) {
			throw httpError(500, ROLE_STATE_ERROR, `角色状态文件形状不认识，已拒绝覆盖：${stateFile}`)
		}
		const roles = []
		for (const raw of parsed.roles) {
			const role = normalizeRole(raw)
			if (role !== null) roles.push(role)
		}
		const active = {}
		if (parsed.active !== null && typeof parsed.active === 'object' && !Array.isArray(parsed.active)) {
			for (const [projectRoot, roleId] of Object.entries(parsed.active)) {
				if (typeof roleId === 'string' && roleId !== '') active[projectRoot] = roleId
			}
		}
		state = { version: 1, roles, active }
		return state
	}

	/** 落盘（原子替换）。 */
	function save() {
		mkdirSync(stateDir, { recursive: true })
		const current = load()
		const payload = `${JSON.stringify({ version: 1, roles: current.roles, active: current.active }, null, 2)}\n`
		const tmp = `${stateFile}.tmp-${randomUUID()}`
		writeFileSync(tmp, payload)
		renameSync(tmp, stateFile)
	}

	/** 角色副本（调用方改不动内部状态）。 */
	function copyOf(role) {
		return { id: role.id, name: role.name, skills: [...role.skills], createdAt: role.createdAt, updatedAt: role.updatedAt }
	}

	function list() {
		return load().roles.map(copyOf)
	}

	function get(id) {
		const found = load().roles.find((role) => role.id === id)
		return found === undefined ? null : copyOf(found)
	}

	/** 校验并归一化输入；不合格直接抛。 */
	function validate({ name, skills }) {
		const normalizedName = blank(name)
		if (normalizedName === undefined || normalizedName.length > MAX_NAME_LENGTH) {
			throw httpError(400, 'error.role.name', `角色名必须是 1~${MAX_NAME_LENGTH} 个字符`)
		}
		if (!Array.isArray(skills) || skills.some((entry) => typeof entry !== 'string')) {
			throw httpError(400, 'error.role.skills', 'skills 必须是字符串数组')
		}
		const unique = []
		for (const entry of skills) {
			const name2 = entry.trim()
			if (name2 !== '' && !unique.includes(name2)) unique.push(name2)
		}
		if (unique.length > MAX_ROLE_SKILLS) {
			throw httpError(400, 'error.role.tooMany', `一个角色最多 ${MAX_ROLE_SKILLS} 个技能`)
		}
		return { name: normalizedName, skills: unique }
	}

	/**
	 * 新建或更新一个角色。
	 * @param input - `{id?, name, skills, now?}`。
	 * @returns 保存后的角色副本。
	 */
	function upsert(input) {
		const current = load()
		const clean = validate(input)
		const now = Number(input.now) || Date.now()
		// id 必须先归一化再参与比较：否则带空白的 id 会让角色「和自己重名」，抛假 409。
		const id = blank(input.id)
		const found = id === undefined ? undefined : current.roles.find((role) => role.id === id)
		// 给了 id 却找不到角色 → 404 优先于重名 409（同一个 id 不可能既不存在、又撞名）。
		if (id !== undefined && found === undefined) throw httpError(404, 'error.role.unknown', `没有这个角色：${id}`)
		const conflict = current.roles.find((role) => role.name === clean.name && role.id !== id)
		if (conflict !== undefined) throw httpError(409, 'error.role.duplicate', `已经有同名角色：${clean.name}`)

		if (id === undefined) {
			if (current.roles.length >= MAX_ROLES) throw httpError(400, 'error.role.tooMany', `最多 ${MAX_ROLES} 个角色`)
			const role = { id: randomUUID(), name: clean.name, skills: clean.skills, createdAt: now, updatedAt: now }
			current.roles.push(role)
			save()
			return copyOf(role)
		}
		found.name = clean.name
		found.skills = clean.skills
		found.updatedAt = now
		save()
		return copyOf(found)
	}

	/**
	 * 删除角色。**不动磁盘上的任何技能文件**；指向它的激活记录一并清掉。
	 * @param id - 角色 id。
	 * @returns `{removed, clearedProjects}`。
	 */
	function remove(id) {
		const current = load()
		const index = current.roles.findIndex((role) => role.id === id)
		if (index === -1) throw httpError(404, 'error.role.unknown', `没有这个角色：${id}`)
		current.roles.splice(index, 1)
		const clearedProjects = []
		for (const projectRoot of Object.keys(current.active)) {
			if (current.active[projectRoot] !== id) continue
			delete current.active[projectRoot]
			clearedProjects.push(projectRoot)
		}
		save()
		return { removed: id, clearedProjects }
	}

	/** 这个项目根当前激活的是哪个角色（没记录或角色已不在 → null）。 */
	function activeFor(projectRoot) {
		const current = load()
		const roleId = current.active[projectRoot]
		if (typeof roleId !== 'string') return null
		return current.roles.some((role) => role.id === roleId) ? roleId : null
	}

	/** 记下这个项目激活了哪个角色。角色必须存在。 */
	function setActive(projectRoot, roleId) {
		const current = load()
		if (!current.roles.some((role) => role.id === roleId)) throw httpError(404, 'error.role.unknown', `没有这个角色：${roleId}`)
		current.active[projectRoot] = roleId
		save()
	}

	/** 清掉这个项目的激活记录（**不动磁盘**）。返回有没有清到东西。 */
	function clearActive(projectRoot) {
		const current = load()
		if (!Object.hasOwn(current.active, projectRoot)) return false
		delete current.active[projectRoot]
		save()
		return true
	}

	return { load, save, list, get, upsert, remove, activeFor, setActive, clearActive, stateFile }
}

/**
 * 算一次切换要做哪些动作。**纯函数，不碰盘。**
 *
 * 严格对齐的语义：角色内的启用、角色外的停用。已经在目标态的不产生动作（幂等）。
 *
 * 同名双副本（一个根里同时有 `foo/SKILL.md` 与 `foo.md`）会一起处置——角色按
 * **技能名**存，所以两条记录按同一规则走。这是刻意的语义，README 里写着。
 *
 * @param input - `{role, skills}`：`role` 是角色对象（或 null），`skills` 是项目根扫描结果。
 * @returns `{steps, noop, skipped, missing, stats}`。
 */
export function planRole(input) {
	const role = input?.role ?? null
	const skills = Array.isArray(input?.skills) ? input.skills : []
	const wanted = new Set(Array.isArray(role?.skills) ? role.skills : [])
	const steps = []
	const noop = []
	const skipped = []
	const seen = new Set()

	for (const skill of skills) {
		const name = typeof skill?.name === 'string' ? skill.name : ''
		if (name === '') continue
		seen.add(name)
		const path = skill.path
		// 不可启停（软链接等）：报告，但不碰。
		if (skill.toggleable !== true) {
			skipped.push({ name, path, reason: skill.readOnlyReason ?? 'readonly' })
			continue
		}
		const target = wanted.has(name)
		if (skill.enabled === target) {
			noop.push({ name, path, enabled: skill.enabled === true })
			continue
		}
		steps.push({ name, path, action: target ? 'enable' : 'disable', current: skill.enabled === true, target })
	}

	const missing = [...wanted].filter((name) => !seen.has(name))
	const stats = {
		total: skills.length,
		enable: steps.filter((step) => step.action === 'enable').length,
		disable: steps.filter((step) => step.action === 'disable').length,
		noop: noop.length,
		skipped: skipped.length,
		missing: missing.length,
	}
	return { steps, noop, skipped, missing, stats }
}

/**
 * 执行一份切换计划。**只接收项目根**——全局根不在这条链路的入参里。
 *
 * 两层结构保证「不修改全局」：
 *   1. 调用方只能传一个根，全局根拿不到；
 *   2. 就算有 bug 把全局路径塞进 plan，`toggleSkill([projectRoot], …)` 里的
 *      `classifyDiscoveryPath` 也只会认落在项目根里的路径，否则 400。
 *
 * 逐项隔离：一项失败不影响其余项（与 /toggle-batch 同一口径）。
 *
 * @param projectRoot - 单个根描述（`resolveRoots()` 里 `key === 'project-dsh'` 那个）。
 * @param plan - `planRole()` 的产物（只读 `plan.steps`）。
 * @returns `{results, changed}`。
 */
export function applyRole(projectRoot, plan) {
	const steps = Array.isArray(plan?.steps) ? plan.steps : []
	const results = []
	let changed = 0
	for (const step of steps) {
		try {
			const outcome = toggleSkill([projectRoot], step.path, step.target)
			if (outcome.changed) changed += 1
			results.push({ name: step.name, path: outcome.path, ok: true, enabled: outcome.enabled, changed: outcome.changed })
		} catch (error) {
			results.push({ name: step.name, path: step.path, ok: false, code: error?.code ?? 'error.unknown', error: errorTextOf(error) })
		}
	}
	return { results, changed }
}
