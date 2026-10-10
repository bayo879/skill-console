# 角色（技能组合）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 DSH 技能控制台加第三个标签页「角色」，把一组技能存成命名组合，切换角色即成套改变**当前项目**的技能，全程不碰全局技能根。

**Architecture:** 新增宿主模块 `lib/roles.js`（存储 / 纯函数计划 / 执行三层，职责不重叠），在 `lib/routes.js` 挂 6 个新端点，在 `lib/client.js` 加第三个 tab 与 `RolesPanel`。写盘复用现有唯一破坏性操作 `toggleSkill`（重命名发现文件），并用「只把项目根传进执行层」这一结构约束保证全局不可达。

**Tech Stack:** Node 22 ESM、`node:fs`（宿主侧不用 `ctx.fs`）、手写 lazy-CJS 客户端 bundle（`window.__ModuleLoader__.load`）。**无第三方依赖、无构建步骤。**

**Spec:** `docs/readme/roles.md`

## Global Constraints

- Node `>=22.15`，ESM（`"type": "module"`）。
- **不得新增任何 npm 依赖**：`package.json` 的 `dependencies` 必须保持为空（`test/contract.mjs` 守着这条）。
- 注释与文案一律中文。
- 宿主侧文件操作一律 `node:fs`，**不用 `ctx.fs`**（沙箱会拒工作区外路径；宿主 `apply()` 跑在宿主进程里，这是本来的权限面）。
- 宿主侧读 cordis 服务：只能按属性读 `inject` 里声明过的；可选服务只能用 `ctx.get(name, false)`。用户态代码里**不得**出现 `ctx.webRuntime?.x` 这种读法。新增的 `roles.js` 必须加进 `test/contract.mjs` 的 `HOST_FILES` 数组，否则这条扫描覆盖不到它。
- 客户端 bundle 只能 `require('react')` 与 `require('@deepseek-ai/dsh-client-ui-primitives')`；`inject` 必须保持 `['slots','locale']`；只能读已 inject 的服务。
- locale 的 `zh` 与 `en` 词典**键集必须完全一致**（缺一个键英文界面就吐出机器码）。
- 写盘只有一种方式：重命名发现文件（`roots.js` 的 `toggleSkill`）。**不新增第二种写盘语义**。
- 角色切换**只允许**写项目技能根；全局根在结构上不可达。
- 所有写路由必须登记在 `WRITE_ROUTES`（POST + `x-skill-console: 1` + `content-type: application/json`）。
- **不做 git 提交**：本工作区 `skill-console/` 未被任何仓库跟踪，最近的仓库根 `.../dsh` 混着大量无关临时目录。每个任务以「跑通测试」收尾，代替提交步骤。
- 每个任务结束都要跑（在 `skill-console/` 目录下）：`node dsh-plugin/test/contract.mjs`，**失败数必须为 0**。
- **本计划里所有的行号都只是线索，不是锚点。** 计划写完后实测发现 `dsh-plugin/lib/client.js` 在会话进行中从 2200 行变成了 2343 行（`sc-tabs` 从约 2114 行移到 2256 行），且改动与本功能无关（文件里搜不到 `tab.roles`）——疑似有另一个进程在并发改同一文件。所以：**每开一个任务前先重新读一遍要改的文件**，用函数名/字符串锚点定位（例如 `h(UiPill, { active: tab === 'repos'`、`exports.sessionIdOf = sessionIdOf`），不要把行号当准。若发现文件又变了，先把本任务要改的区域重新读一遍再动手。

---

## 文件结构

| 文件 | 动作 | 职责 |
| --- | --- | --- |
| `dsh-plugin/lib/roles.js` | 新建 | 角色持久化 + `planRole` 纯函数 + `applyRole` 执行。**不碰 `SKILL.md` 之外的任何东西**，扫描与重命名一律走 `roots.js`。 |
| `dsh-plugin/lib/routes.js` | 改 | 新增 6 个 handler 与路由表条目，并在 `index.js` 传入 `roleStore`。 |
| `dsh-plugin/lib/index.js` | 改 | `createRoleStore({stateDir, log})` 并透传给 `createPrefixHandler`。 |
| `dsh-plugin/lib/client.js` | 改 | 第三个 tab、`RolesPanel` / `RoleEditor` / `RoleRow`、词条、样式、测试导出。 |
| `dsh-plugin/package.json` | 改 | 版本 `0.2.1` → `0.3.0`。 |
| `dsh-plugin/test/contract.mjs` | 改 | 角色存储 / 计划 / 执行 / 路由 / 客户端五节。 |
| `dsh-plugin/test/integration-cordis.mjs` | 改 | 真 cordis 下探一次 `/roles`。 |
| `dsh-plugin/test/smoke.mjs` | 改 | 非破坏性的角色往返（见 Task 7 的说明）。 |
| `docs/HTTP-API.md` | 改 | 补 6 个端点。 |
| `README.md` | 改 | 功能节、设计边界、已知边界、模块图、文档索引。 |
| `docs/readme/roles.md` | 改 | §9 冒烟计划改成非破坏性方案；状态改「已实现」。 |

### 跨任务接口（后面每个任务都按这套名字，别改）

`dsh-plugin/lib/roles.js` 全部导出：

```js
export const MAX_ROLES = 50
export const MAX_ROLE_SKILLS = 200
export const ROLE_STATE_ERROR = 'error.role.state'

export function createRoleStore({ stateDir, log })
// → { load, save, list, get, upsert, remove, activeFor, setActive, clearActive, stateFile }
//   list()                    → Role[]（每次返回新对象，调用方改不动内部状态）
//   get(id)                   → Role | null
//   upsert({id?, name, skills, now?}) → Role      // 校验失败抛 httpError
//   remove(id)                → { removed, clearedProjects: string[] }
//   activeFor(projectRoot)    → string | null
//   setActive(projectRoot, roleId) → void          // roleId 不存在抛 404
//   clearActive(projectRoot)  → boolean

export function planRole({ role, skills })
// → { steps, noop, skipped, missing, stats }
//   steps:   [{ name, path, action: 'enable'|'disable', current, target }]
//   noop:    [{ name, path, enabled }]
//   skipped: [{ name, path, reason }]
//   missing: string[]
//   stats:   { total, enable, disable, noop, skipped, missing }

export function applyRole(projectRoot, plan)
// → { results: [{ name, path, ok, enabled?, changed?, code?, error? }], changed }
```

`Role` 形状：`{ id, name, skills: string[], createdAt, updatedAt }`。

---

## Task 1: `roles.js` 存储层

**Files:**
- Create: `dsh-plugin/lib/roles.js`
- Modify: `dsh-plugin/test/contract.mjs`（新增「角色存储」一节；并在 `HOST_FILES` 数组里加 `'roles.js'`）

**Interfaces:**
- Produces: `MAX_ROLES`, `MAX_ROLE_SKILLS`, `ROLE_STATE_ERROR`, `createRoleStore({stateDir, log})`

- [ ] **Step 1: 写失败测试**

在 `test/contract.mjs` 的 `HOST_FILES` 数组里加一项（当前是 14 项，加完 15 项）：

```js
const HOST_FILES = [
	'index.js', 'http.js', 'routes.js', 'roots.js', 'frontmatter.js', 'diagnostics.js',
	'repos.js', 'repo-manifest.js', 'github.js', 'store.js', 'backups.js', 'rows.js',
	'projects.js', 'gitsha.js', 'roles.js',
]
```

然后在 `section('2b. 项目列表')` 那一节之后插入新小节：

```js
// ── 2c. 角色存储 ──────────────────────────────────────────────────────────

section('角色存储：原子写 / 损坏拒写 / 校验')
const rolesModule = await import(join(LIB, 'roles.js'))
const roleStateDir = tempDir('sc-roles')
const roleStore = rolesModule.createRoleStore({ stateDir: roleStateDir, log: () => {} })

check('初始状态没有角色', roleStore.list().length === 0)
check('空状态里 active 是空表', roleStore.activeFor(projectDir) === null)

const createdRole = roleStore.upsert({ name: '前端', skills: ['alpha', 'beta'] })
check('新建角色拿到 id', typeof createdRole.id === 'string' && createdRole.id.length > 0, JSON.stringify(createdRole))
check('新建角色保留技能名', createdRole.skills.join(',') === 'alpha,beta', createdRole.skills.join(','))
check('落盘后能在磁盘上读到', readFileSync(join(roleStateDir, 'roles.json'), 'utf8').includes('前端'))
check('技能名去重', roleStore.upsert({ id: createdRole.id, name: '前端', skills: ['alpha', 'alpha', 'beta'] }).skills.join(',') === 'alpha,beta')

const renamed = roleStore.upsert({ id: createdRole.id, name: '前端 v2', skills: ['gamma'] })
check('按 id 更新不新建', roleStore.list().length === 1 && renamed.name === '前端 v2', JSON.stringify(roleStore.list()))
check('list() 返回的是副本（改不动内部状态）', (() => { const list = roleStore.list(); list[0].name = '被改了'; return roleStore.list()[0].name === '前端 v2' })())

/** 取一次错误码（不抛出去）。 */
function codeOf(fn) {
	try { fn(); return null } catch (error) { return error?.code ?? String(error) }
}

check('重名被拒（409）', codeOf(() => roleStore.upsert({ name: '前端 v2', skills: [] })) === 'error.role.duplicate')
check('空名被拒（400）', codeOf(() => roleStore.upsert({ name: '   ', skills: [] })) === 'error.role.name')
check('名字不是字符串被拒（400）', codeOf(() => roleStore.upsert({ name: 7, skills: [] })) === 'error.role.name')
check('skills 不是数组被拒（400）', codeOf(() => roleStore.upsert({ name: '坏的', skills: 'alpha' })) === 'error.role.skills')
check('skills 里混进非字符串被拒（400）', codeOf(() => roleStore.upsert({ name: '坏的', skills: ['a', 7] })) === 'error.role.skills')
check('更新不存在的角色 404', codeOf(() => roleStore.upsert({ id: 'nope', name: 'x', skills: [] })) === 'error.role.unknown')

roleStore.setActive(projectDir, createdRole.id)
check('激活记录按项目根存', roleStore.activeFor(projectDir) === createdRole.id)
check('别的项目没有激活记录', roleStore.activeFor('/tmp/another-project') === null)
check('激活不存在的角色 404', codeOf(() => roleStore.setActive(projectDir, 'nope')) === 'error.role.unknown')
check('clearActive 清掉记录并返回 true', roleStore.clearActive(projectDir) === true && roleStore.activeFor(projectDir) === null)
check('clearActive 对没有记录的项目返回 false', roleStore.clearActive(projectDir) === false)

roleStore.setActive(projectDir, createdRole.id)
const removedRole = roleStore.remove(createdRole.id)
check('remove 报告删掉的 id', removedRole.removed === createdRole.id)
check('remove 一并清掉指向它的激活记录', removedRole.clearedProjects.includes(projectDir) && roleStore.activeFor(projectDir) === null)
check('删除后列表为空', roleStore.list().length === 0)
check('删除不存在的角色 404', codeOf(() => roleStore.remove('nope')) === 'error.role.unknown')

// 上限：角色数
const limitStore = rolesModule.createRoleStore({ stateDir: tempDir('sc-roles-limit'), log: () => {} })
for (let index = 0; index < rolesModule.MAX_ROLES; index += 1) limitStore.upsert({ name: `r${index}`, skills: [] })
check('可以建到上限', limitStore.list().length === rolesModule.MAX_ROLES)
check('角色数超上限被拒（400）', codeOf(() => limitStore.upsert({ name: 'overflow', skills: [] })) === 'error.role.tooMany')
const firstLimitRole = limitStore.list()[0]
check(
	'每角色技能数超上限被拒（400）',
	codeOf(() => limitStore.upsert({
		id: firstLimitRole.id,
		name: firstLimitRole.name,
		skills: Array.from({ length: rolesModule.MAX_ROLE_SKILLS + 1 }, (_, index) => `s${index}`),
	})) === 'error.role.tooMany',
)

// 损坏的状态文件：拒绝读、拒绝写、原样保留
const corruptRoleDir = tempDir('sc-roles-corrupt')
const corruptRoleFile = join(corruptRoleDir, 'roles.json')
writeFileSync(corruptRoleFile, 'this is not json')
const corruptRoleStore = rolesModule.createRoleStore({ stateDir: corruptRoleDir, log: () => {} })
check('损坏的状态文件拒读（500 error.role.state）', codeOf(() => corruptRoleStore.list()) === 'error.role.state')
check('损坏时拒绝任何写入', codeOf(() => corruptRoleStore.upsert({ name: 'x', skills: [] })) === 'error.role.state')
check('损坏的状态文件原样保留', readFileSync(corruptRoleFile, 'utf8') === 'this is not json')

const wrongShapeDir = tempDir('sc-roles-shape')
const wrongShapeFile = join(wrongShapeDir, 'roles.json')
writeFileSync(wrongShapeFile, JSON.stringify({ version: 1, roles: 'nope' }))
check('形状不认识也拒读', codeOf(() => rolesModule.createRoleStore({ stateDir: wrongShapeDir, log: () => {} }).list()) === 'error.role.state')
check('形状不认识时原文件不动', JSON.parse(readFileSync(wrongShapeFile, 'utf8')).roles === 'nope')
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `node dsh-plugin/test/contract.mjs`
Expected: 崩在 `await import(join(LIB, 'roles.js'))`，`ERR_MODULE_NOT_FOUND`。

- [ ] **Step 3: 实现 `roles.js` 的存储层**

新建 `dsh-plugin/lib/roles.js`：

```js
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
		const conflict = current.roles.find((role) => role.name === clean.name && role.id !== input.id)
		if (conflict !== undefined) throw httpError(409, 'error.role.duplicate', `已经有同名角色：${clean.name}`)

		const id = blank(input.id)
		if (id === undefined) {
			if (current.roles.length >= MAX_ROLES) throw httpError(400, 'error.role.tooMany', `最多 ${MAX_ROLES} 个角色`)
			const role = { id: randomUUID(), name: clean.name, skills: clean.skills, createdAt: now, updatedAt: now }
			current.roles.push(role)
			save()
			return copyOf(role)
		}
		const found = current.roles.find((role) => role.id === id)
		if (found === undefined) throw httpError(404, 'error.role.unknown', `没有这个角色：${id}`)
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
		if (!(projectRoot in current.active)) return false
		delete current.active[projectRoot]
		save()
		return true
	}

	return { load, save, list, get, upsert, remove, activeFor, setActive, clearActive, stateFile }
}
```

- [ ] **Step 4: 跑测试，确认通过**

Run: `node dsh-plugin/test/contract.mjs`
Expected: 全绿，失败 0。

---

## Task 2: `planRole` 纯函数

**Files:**
- Modify: `dsh-plugin/lib/roles.js`（追加 `planRole`）
- Modify: `dsh-plugin/test/contract.mjs`（追加「角色计划」一节）

**Interfaces:**
- Consumes: Task 1 的 `roles.js` 模块；`roots.js` 的 `scanRoot(root)` 输出的技能记录（字段 `name / path / enabled / toggleable / readOnlyReason`）。
- Produces: `planRole({role, skills})`。

- [ ] **Step 1: 写失败测试**

紧接 Task 1 的「角色存储」一节之后插入：

```js
// ── 2d. 角色计划（纯函数，不碰盘） ─────────────────────────────────────────

section('角色计划：planRole 不碰盘')
const planProject = tempDir('sc-role-plan')
const planProjectRoot = { key: 'project-dsh', scope: 'project', label: '项目 DSH', rank: 100, path: planProject, exists: true, writable: true }

/** 在指定根下放一个技能。`enabled=false` 写成 `.disabled`。 */
function placeSkill(rootPath, name, enabled = true) {
	const dir = join(rootPath, name)
	mkdirSync(dir, { recursive: true })
	writeFileSync(join(dir, enabled ? 'SKILL.md' : 'SKILL.md.disabled'), `---\nname: ${name}\ndescription: ${name} 的说明\n---\n\n# ${name}\n`)
}

placeSkill(planProject, 'alpha', true)
placeSkill(planProject, 'beta', false)
placeSkill(planProject, 'gamma', true)
const planSkills = roots.scanRoot(planProjectRoot).skills
check('扫描出三个技能', planSkills.length === 3, planSkills.map((skill) => skill.name).join(','))

const plan = rolesModule.planRole({ role: { id: 'r', name: 'r', skills: ['alpha', 'beta'] }, skills: planSkills })
check('角色内已关闭的技能进入 enable', plan.steps.some((step) => step.name === 'beta' && step.action === 'enable' && step.target === true))
check('角色外已开启的技能进入 disable', plan.steps.some((step) => step.name === 'gamma' && step.action === 'disable' && step.target === false))
check('已在目标态的不产生动作', plan.noop.some((entry) => entry.name === 'alpha' && entry.enabled === true))
check('没有缺失', plan.missing.length === 0, plan.missing.join(','))
check('stats 汇总正确', plan.stats.total === 3 && plan.stats.enable === 1 && plan.stats.disable === 1 && plan.stats.noop === 1 && plan.stats.skipped === 0, JSON.stringify(plan.stats))
check('planRole 不碰盘（beta 还是 .disabled）', existsSync(join(planProject, 'beta', 'SKILL.md.disabled')) && !existsSync(join(planProject, 'beta', 'SKILL.md')))

const planMissing = rolesModule.planRole({ role: { id: 'r', name: 'r', skills: ['alpha', 'nope'] }, skills: planSkills })
check('角色里有、项目没有的技能进 missing', planMissing.missing.join(',') === 'nope', planMissing.missing.join(','))

const planAll = rolesModule.planRole({ role: { id: 'r', name: 'r', skills: ['alpha', 'beta', 'gamma'] }, skills: planSkills })
check('全部纳入时只剩一个 enable', planAll.steps.length === 1 && planAll.steps[0].name === 'beta', JSON.stringify(planAll.steps))

// 同名双副本：一个根里同时有 foo/SKILL.md 与 foo.md，两者 name 都是 foo
const twinRootPath = tempDir('sc-role-twin')
mkdirSync(join(twinRootPath, 'twin'), { recursive: true })
writeFileSync(join(twinRootPath, 'twin', 'SKILL.md'), '---\nname: twin\ndescription: 目录形态\n---\n')
writeFileSync(join(twinRootPath, 'twin.md'), '---\nname: twin\ndescription: 扁平形态\n---\n')
const twinRoot = { ...planProjectRoot, path: twinRootPath }
const twinSkills = roots.scanRoot(twinRoot).skills
check('同名双副本都被扫到', twinSkills.filter((skill) => skill.name === 'twin').length === 2, String(twinSkills.length))
const twinPlan = rolesModule.planRole({ role: { id: 'r', name: 'r', skills: [] }, skills: twinSkills })
check('同名双副本一起进 disable', twinPlan.steps.filter((step) => step.name === 'twin' && step.action === 'disable').length === 2, JSON.stringify(twinPlan.steps))
check('同名双副本都不算 missing', rolesModule.planRole({ role: { id: 'r', name: 'r', skills: ['twin'] }, skills: twinSkills }).missing.length === 0)

// 软链接：不可启停，必须进 skipped 而不是 steps。
// 真身必须放在**被扫描的根之外**再链进来：否则真身目录自己也会被扫成一条同名记录，
// 而那条是合法可启停的，「软链接不进 steps」就会被它误伤（同款写法见 contract.mjs 180-182 行）。
const linkRootPath = tempDir('sc-role-link')
const linkRealPath = join(tempDir('sc-role-link-real'), 'linked')
mkdirSync(linkRealPath, { recursive: true })
writeFileSync(join(linkRealPath, 'SKILL.md'), '---\nname: linked\ndescription: 真身\n---\n')
symlinkSync(linkRealPath, join(linkRootPath, 'linked'))
const linkRoot = { ...planProjectRoot, path: linkRootPath }
const linkPlan = rolesModule.planRole({ role: { id: 'r', name: 'r', skills: [] }, skills: roots.scanRoot(linkRoot).skills })
check('软链接技能进 skipped', linkPlan.skipped.some((entry) => entry.name === 'linked'), JSON.stringify(linkPlan.skipped))
check('软链接技能不进 steps', !linkPlan.steps.some((step) => step.name === 'linked'), JSON.stringify(linkPlan.steps))
check('角色里的软链接技能不算 missing', rolesModule.planRole({ role: { id: 'r', name: 'r', skills: ['linked'] }, skills: roots.scanRoot(linkRoot).skills }).missing.length === 0)

check('空角色 + 空清单不崩', (() => { const empty = rolesModule.planRole({ role: { id: 'r', name: 'r', skills: [] }, skills: [] }); return empty.steps.length === 0 && empty.stats.total === 0 })())
check('role 为 null 时不崩', rolesModule.planRole({ role: null, skills: planSkills }).missing.length === 0)
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `node dsh-plugin/test/contract.mjs`
Expected: FAIL —— `rolesModule.planRole is not a function`。

- [ ] **Step 3: 实现 `planRole`**

追加到 `roles.js` 末尾：

```js
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
```

- [ ] **Step 4: 跑测试，确认通过**

Run: `node dsh-plugin/test/contract.mjs`
Expected: 全绿，失败 0。

---

## Task 3: `applyRole` 执行层

**Files:**
- Modify: `dsh-plugin/lib/roles.js`（追加 `applyRole`）
- Modify: `dsh-plugin/test/contract.mjs`（追加「角色执行」一节）

**Interfaces:**
- Consumes: Task 2 的 `planRole`；`roots.js` 的 `resolveRoots` / `scanRoot` / `toggleSkill`。
- Produces: `applyRole(projectRoot, plan)`。

- [ ] **Step 1: 写失败测试**

紧接「角色计划」一节之后插入：

```js
// ── 2e. 角色执行（只动项目根） ────────────────────────────────────────────

section('角色执行：全局根在结构上不可达')
const applyHome = tempDir('sc-role-apply-home')
const applyProject = tempDir('sc-role-apply-project')
mkdirSync(join(applyProject, '.git'), { recursive: true })
placeSkill(join(applyHome, 'skills'), 'alpha', true)
placeSkill(join(applyProject, '.dsh', 'skills'), 'alpha', true)
placeSkill(join(applyProject, '.dsh', 'skills'), 'beta', true)

const applyRoots = roots.resolveRoots({ dshHome: applyHome, projectCwd: applyProject })
const applyProjectRoot = applyRoots.find((root) => root.key === 'project-dsh')
const applyGlobalRoot = applyRoots.find((root) => root.key === 'user-dsh')
const globalAlphaPath = join(applyHome, 'skills', 'alpha', 'SKILL.md')
const globalAlphaMtime = statSync(globalAlphaPath).mtimeMs

const applied = rolesModule.applyRole(applyProjectRoot, rolesModule.planRole({ role: { id: 'r', name: 'r', skills: ['alpha'] }, skills: roots.scanRoot(applyProjectRoot).skills }))
check('执行逐项回结果', applied.results.length === 1 && applied.results[0].ok === true, JSON.stringify(applied.results))
check('项目根里的 beta 被停用', existsSync(join(applyProject, '.dsh', 'skills', 'beta', 'SKILL.md.disabled')) && !existsSync(join(applyProject, '.dsh', 'skills', 'beta', 'SKILL.md')))
check('全局根的 alpha 还在原位（名字没变）', existsSync(globalAlphaPath))
check('全局根的 alpha 内容没被碰（mtime 未变）', statSync(globalAlphaPath).mtimeMs === globalAlphaMtime)
check('全局根没多出 .disabled 文件', !existsSync(`${globalAlphaPath}.disabled`))

const appliedAgain = rolesModule.applyRole(applyProjectRoot, rolesModule.planRole({ role: { id: 'r', name: 'r', skills: ['alpha'] }, skills: roots.scanRoot(applyProjectRoot).skills }))
check('再切一次完全幂等（0 动作）', appliedAgain.changed === 0 && appliedAgain.results.length === 0, JSON.stringify(appliedAgain))

// 结构性保证：就算 plan 里被塞了全局路径，路径围栏也必须挡住
const escaped = rolesModule.applyRole(applyProjectRoot, { steps: [{ name: 'alpha', path: globalAlphaPath, action: 'disable', current: true, target: false }] })
check('plan 里塞全局路径 → 该条目报 error.path.outsideRoots', escaped.results[0]?.ok === false && escaped.results[0]?.code === 'error.path.outsideRoots', JSON.stringify(escaped.results))
check('越界条目没有改到全局文件', existsSync(globalAlphaPath) && statSync(globalAlphaPath).mtimeMs === globalAlphaMtime)

// 逐项隔离：坏项不阻断好项
const isolated = rolesModule.applyRole(applyProjectRoot, {
	steps: [
		{ name: 'ghost', path: join(applyProject, '.dsh', 'skills', 'ghost', 'SKILL.md'), action: 'disable', current: true, target: false },
		{ name: 'alpha', path: join(applyProject, '.dsh', 'skills', 'alpha', 'SKILL.md'), action: 'disable', current: true, target: false },
	],
})
check('坏项报 404 且不抛', isolated.results[0]?.ok === false && isolated.results[0]?.code === 'error.toggle.notFound', JSON.stringify(isolated.results[0]))
check('好项照样执行', isolated.results[1]?.ok === true && isolated.results[1]?.changed === true, JSON.stringify(isolated.results[1]))
check('changed 只数真正改动的', isolated.changed === 1, String(isolated.changed))

// 同态幂等：alpha 在前一小节已被停用，所以这里必须传**当前磁盘上真实存在的**那个发现文件
// （`SKILL.md.disabled`）。传 `SKILL.md` 会命中 existsSync 失败，抛真实 404 而不是同态 changed=false。
const linked = rolesModule.applyRole(applyProjectRoot, { steps: [{ name: 'alpha', path: join(applyProject, '.dsh', 'skills', 'alpha', 'SKILL.md.disabled'), action: 'disable', current: false, target: false }] })
check('已同态时 toggleSkill 回 changed=false，不报错', linked.results[0]?.ok === true && linked.results[0]?.changed === false, JSON.stringify(linked.results[0]))
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `node dsh-plugin/test/contract.mjs`
Expected: FAIL —— `rolesModule.applyRole is not a function`。

- [ ] **Step 3: 实现 `applyRole`**

追加到 `roles.js` 末尾：

```js
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
```

`applyRole` 刻意**不记日志**：失败项由调用方（路由层）随 HTTP 响应汇报，执行层保持「只做、只回结果」。所以函数体到 `return { results, changed }` 就结束，不要再塞 `log(...)`——`log` 是 `createRoleStore` 的闭包变量，`applyRole` 根本接不到。

- [ ] **Step 4: 跑测试，确认通过**

Run: `node dsh-plugin/test/contract.mjs`
Expected: 全绿，失败 0。

---

## Task 4: 6 个路由 + 装配

**Files:**
- Modify: `dsh-plugin/lib/routes.js`
- Modify: `dsh-plugin/lib/index.js`
- Modify: `dsh-plugin/test/contract.mjs`（追加「角色路由」一节）

**Interfaces:**
- Consumes: `createRoleStore` / `planRole` / `applyRole`（Task 1–3）；`routes.js` 现有的 `contextOf` / `takeoverFor` / `publicRoot` / `refreshSkills` / `notifyFileChanged`；`roots.js` 的 `scanRoot`；`projects.js` 的 `resolveProject`。
- Produces: HTTP 端点 `/roles`、`/roles/preview`、`/roles/save`、`/roles/remove`、`/roles/activate`、`/roles/deactivate`。

- [ ] **Step 1: 写失败测试**

在 `test/contract.mjs` 的「宿主路由：围栏 / 标记 / 响应」一节结束之后（即 `const catalog = await call(...)` 那几条断言之后）插入新小节：

```js
// ── 4b. 角色路由 ─────────────────────────────────────────────────────────

section('角色路由：列表 / 预览 / 保存 / 切换 / 取消 / 删除')

/** 写操作必须带的头（少一个就被围栏挡）。 */
const ROLE_WRITE = { 'x-skill-console': '1', 'content-type': 'application/json' }
const roleSession = { 'x-skill-console-session': fakeSession.id }
const rolesProjectSkills = join(projectDir, '.dsh', 'skills')

// 专供本节的名字，避免与前面的用例互相污染
placeSkill(rolesProjectSkills, 'rp-alpha', true)
placeSkill(rolesProjectSkills, 'rp-beta', true)
placeSkill(join(home, 'skills'), 'rp-global', true)

const rolesList = await call({ path: '/api/skill-console/roles', headers: roleSession })
check('GET /roles 返回 200', rolesList.status === 200 && rolesList.json.ok === true, `${rolesList.status} ${JSON.stringify(rolesList.json).slice(0, 160)}`)
check('未激活角色时 status 是 unassigned', rolesList.json.data.status === 'unassigned', String(rolesList.json.data.status))
check('候选里能拿到项目技能', rolesList.json.data.candidates.project.some((entry) => entry.name === 'rp-alpha'), JSON.stringify(rolesList.json.data.candidates.project.map((entry) => entry.name)))
check('候选里的全局技能标了只读', rolesList.json.data.candidates.global.every((entry) => entry.readOnly === true && entry.reason === 'global-uncontrollable'))
check('候选人带齐字段', rolesList.json.data.candidates.project.every((entry) => ['name', 'path', 'enabled', 'toggleable'].every((key) => key in entry)))
check('带回项目名与 fallback 标记', typeof rolesList.json.data.project?.name === 'string' && typeof rolesList.json.data.project?.fallback === 'boolean', JSON.stringify(rolesList.json.data.project))

const savedRoleResponse = await call({ method: 'POST', path: '/api/skill-console/roles/save', headers: { ...ROLE_WRITE, ...roleSession }, body: { name: '冒烟角色', skills: ['rp-alpha'] } })
check('POST /roles/save 建了角色', savedRoleResponse.status === 200 && typeof savedRoleResponse.json.data.role.id === 'string', JSON.stringify(savedRoleResponse.json).slice(0, 160))
const savedRoleId = savedRoleResponse.json.data.role.id
check('保存后出现在列表里', (await call({ path: '/api/skill-console/roles', headers: roleSession })).json.data.roles.some((role) => role.id === savedRoleId))

const rolePreview = await call({ path: `/api/skill-console/roles/preview?role=${savedRoleId}`, headers: roleSession })
check('preview 列出将停用的技能', rolePreview.status === 200 && rolePreview.json.data.steps.some((step) => step.name === 'rp-beta' && step.action === 'disable'), JSON.stringify(rolePreview.json).slice(0, 200))
check('preview 不落盘', existsSync(join(rolesProjectSkills, 'rp-beta', 'SKILL.md')))
check('preview 缺 role 参数 400', (await call({ path: '/api/skill-console/roles/preview', headers: roleSession })).json.code === 'error.proto.missingId')
check('preview 未知角色 404', (await call({ path: '/api/skill-console/roles/preview?role=nope', headers: roleSession })).json.code === 'error.role.unknown')

const activated = await call({ method: 'POST', path: '/api/skill-console/roles/activate', headers: { ...ROLE_WRITE, ...roleSession }, body: { id: savedRoleId } })
check('POST /roles/activate 返回 200', activated.status === 200 && activated.json.ok === true, JSON.stringify(activated.json).slice(0, 200))
check('activate 报告逐项结果', Array.isArray(activated.json.data.results) && activated.json.data.results.length >= 1)
check('activate 之后磁盘上 rp-beta 被停用', existsSync(join(rolesProjectSkills, 'rp-beta', 'SKILL.md.disabled')) && !existsSync(join(rolesProjectSkills, 'rp-beta', 'SKILL.md')))
check('activate 之后 rp-alpha 是启用的', existsSync(join(rolesProjectSkills, 'rp-alpha', 'SKILL.md')))
check('activate 之后 status 是 matched', activated.json.data.status === 'matched', String(activated.json.data.status))
check('activate 不回显角色里的绝对路径以外的东西（只回 id/name）', typeof activated.json.data.role?.id === 'string' && typeof activated.json.data.role?.name === 'string')
check('整轮操作没有动全局技能根', existsSync(join(home, 'skills', 'rp-global', 'SKILL.md')) && !existsSync(join(home, 'skills', 'rp-global', 'SKILL.md.disabled')))
check('全局同名接管被逐条报告（rp-beta 全局没有 → 空表）', Array.isArray(activated.json.data.takeover))

const afterActivate = await call({ path: '/api/skill-console/roles', headers: roleSession })
check('列表里 active 标记落到那个角色', afterActivate.json.data.active?.id === savedRoleId, JSON.stringify(afterActivate.json.data.active))
check('对齐后 status 是 matched', afterActivate.json.data.status === 'matched', String(afterActivate.json.data.status))
check('对齐后 stats.disable 为 0', afterActivate.json.data.stats.disable === 0, JSON.stringify(afterActivate.json.data.stats))

// 手工改一个开关 → 面板必须显示「已偏离」，且不自动纠正
await call({ method: 'POST', path: '/api/skill-console/toggle', headers: { ...ROLE_WRITE, ...roleSession }, body: { path: join(rolesProjectSkills, 'rp-alpha', 'SKILL.md'), enabled: false } })
const drifted = await call({ path: '/api/skill-console/roles', headers: roleSession })
check('手工改开关后 status 是 drifted', drifted.json.data.status === 'drifted', String(drifted.json.data.status))
check('漂移不自动纠正（文件仍是 .disabled）', existsSync(join(rolesProjectSkills, 'rp-alpha', 'SKILL.md.disabled')))

const deactivated = await call({ method: 'POST', path: '/api/skill-console/roles/deactivate', headers: { ...ROLE_WRITE, ...roleSession } })
check('POST /roles/deactivate 返回 200', deactivated.status === 200 && deactivated.json.ok === true, JSON.stringify(deactivated.json).slice(0, 160))
check('deactivate 只清记录、不动磁盘', existsSync(join(rolesProjectSkills, 'rp-alpha', 'SKILL.md.disabled')))
check('取消后回到 unassigned', (await call({ path: '/api/skill-console/roles', headers: roleSession })).json.data.status === 'unassigned')

const removedRoleResponse = await call({ method: 'POST', path: '/api/skill-console/roles/remove', headers: { ...ROLE_WRITE, ...roleSession }, body: { id: savedRoleId } })
check('POST /roles/remove 删掉角色', removedRoleResponse.status === 200 && removedRoleResponse.json.data.removed === savedRoleId, JSON.stringify(removedRoleResponse.json).slice(0, 160))
check('删角色不动磁盘', existsSync(join(rolesProjectSkills, 'rp-alpha', 'SKILL.md.disabled')))
check('remove 缺 id 400', (await call({ method: 'POST', path: '/api/skill-console/roles/remove', headers: { ...ROLE_WRITE, ...roleSession }, body: {} })).json.code === 'error.proto.missingId')
check('remove 未知 id 404', (await call({ method: 'POST', path: '/api/skill-console/roles/remove', headers: { ...ROLE_WRITE, ...roleSession }, body: { id: 'nope' } })).json.code === 'error.role.unknown')

// 围栏对 6 个新端点同样生效
const roleNoMarker = await call({ method: 'POST', path: '/api/skill-console/roles/save', headers: roleSession, body: { name: 'x', skills: [] } })
check('角色写端点缺标记 403', roleNoMarker.status === 403 && roleNoMarker.json.code === 'error.proto.forbidden', `${roleNoMarker.status} ${roleNoMarker.json?.code}`)
const roleGetOnWrite = await call({ path: '/api/skill-console/roles/save', headers: roleSession })
check('角色写端点用 GET 405', roleGetOnWrite.status === 405 && roleGetOnWrite.json.code === 'error.proto.method', `${roleGetOnWrite.status} ${roleGetOnWrite.json?.code}`)
const rolePostOnRead = await call({ method: 'POST', path: '/api/skill-console/roles', headers: { ...ROLE_WRITE, ...roleSession } })
check('角色读端点用 POST 405', rolePostOnRead.status === 405 && rolePostOnRead.json.code === 'error.proto.method', `${rolePostOnRead.status} ${rolePostOnRead.json?.code}`)

// 守卫 ctx（真实 cordis 语义）下也要跑通
const guardedRoles = await callRouteOrReport(guarded.routeOf(), { path: '/api/skill-console/roles', headers: roleSession })
check('守卫 ctx 下 GET /roles 返回 200', guardedRoles.status === 200, guardedRoles.threw ?? `${guardedRoles.status} ${JSON.stringify(guardedRoles.json).slice(0, 160)}`)
```

`placeSkill` 是 Task 2 定义的辅助函数，本节复用它——**把 `placeSkill` 的定义留在 Task 2 那一节里**（它在文件里是个函数声明，后续小节都能用）。

- [ ] **Step 2: 跑测试，确认失败**

Run: `node dsh-plugin/test/contract.mjs`
Expected: FAIL —— `GET /roles` 返回 404 `error.proto.unknownRoute`。

- [ ] **Step 3: 实现路由**

`lib/routes.js` 头部 import 改一行（加 `basename` 与 roles 模块）：

```js
import { basename } from 'node:path'

import { scanRoot, toggleSkill, readSkill, findCollisions } from './roots.js'
import { applyRole, planRole } from './roles.js'
```

`createRouteHandlers(deps)` 里 `const { ctx, repositories, dshHome, stateDir, skillsDir, version, refreshSkills, notifyFileChanged } = deps` 改成多取一个 `roleStore`：

```js
	const { ctx, repositories, dshHome, stateDir, skillsDir, version, refreshSkills, notifyFileChanged, roleStore } = deps
```

在 `contextOf` 后面加一个角色专用的小工具（**不重复 `contextOf` 的活儿**）：

```js
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
```

然后加 6 个 handler（插在 `backups` 之前）：

```js
		async roles(req, url) {
			const sessionId = url.searchParams.get('project') ?? req.headers['x-skill-console-session']
			const { project, projectRoot, globalRoot } = roleContextOf(sessionId)
			const activeRole = activeRoleOf(project)
			const projectSkills = projectSkillsOf(projectRoot)
			const plan = activeRole === null ? null : planRole({ role: activeRole, skills: projectSkills })
			const stats = plan === null
				? { inRole: 0, total: projectSkills.length, enable: 0, disable: 0, noop: 0, skipped: 0, missing: 0 }
				: { inRole: activeRole.skills.length, ...plan.stats }
			return {
				roles: roleStore.list().map((role) => publicRole(role, activeRole?.id ?? null)),
				active: activeRole === null ? null : { id: activeRole.id, name: activeRole.name },
				project: project === null ? null : { name: basename(project.root), fallback: project.fallback === true },
				status: statusOf(activeRole, plan),
				stats,
				candidates: {
					project: projectSkills.map((skill) => candidateOf(skill, false)),
					global: (globalRoot === null ? [] : scanRoot(globalRoot).skills).map((skill) => candidateOf(skill, true)),
				},
			}
		},

		async rolesPreview(req, url) {
			const roleId = url.searchParams.get('role')
			if (roleId === null || roleId.trim() === '') throw httpError(400, 'error.proto.missingId', '缺少 role 参数')
			const role = roleStore.get(roleId)
			if (role === null) throw httpError(404, 'error.role.unknown', `没有这个角色：${roleId}`)
			const sessionId = url.searchParams.get('project') ?? req.headers['x-skill-console-session']
			const { projectRoot } = roleContextOf(sessionId)
			const plan = planRole({ role, skills: projectSkillsOf(projectRoot) })
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
			const { project, projectRoot, roots } = roleContextOf(req.headers['x-skill-console-session'])
			if (project === null || projectRoot === null) throw httpError(400, 'error.role.noProject', '解析不出项目根，无法切换角色')
			const plan = planRole({ role, skills: projectSkillsOf(projectRoot) })
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
			}
		},

		async rolesDeactivate(req) {
			const { project } = roleContextOf(req.headers['x-skill-console-session'])
			if (project === null) throw httpError(400, 'error.role.noProject', '解析不出项目根，无法取消角色')
			return { cleared: roleStore.clearActive(project.root) }
		},
```

路由表加进去：

```js
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
```

`createRouteHandlers` 的 JSDoc `@param deps` 补上 `roleStore`。

- [ ] **Step 4: 在 `index.js` 里装配**

`lib/index.js`：import 加一行、`apply()` 里建 store、透传。

```js
import { createRoleStore } from './roles.js'
```

```js
	const repositories = createRepositoryManager({ stateDir, skillsDir, log })
	const roleStore = createRoleStore({ stateDir, log })
```

`createPrefixHandler({...})` 的 deps 对象里加 `roleStore,`（放在 `repositories,` 后面）。

- [ ] **Step 5: 跑测试，确认通过**

Run: `node dsh-plugin/test/contract.mjs`
Expected: 全绿，失败 0。若「宿主侧没有未 inject 就按属性读服务」那条失败，检查 Task 1 里有没有漏加 `HOST_FILES`。

---

## Task 5: 客户端词条 + 第三个 tab + `roleStatusOf`

**Files:**
- Modify: `dsh-plugin/lib/client.js`
- Modify: `dsh-plugin/test/contract.mjs`（在「浏览器半边」一节里追加）

**Interfaces:**
- Produces: 客户端导出 `roleStatusOf`；DICT 里 `tab.roles` 与 `roles.*` 全套键；`sc-tabs` 的第三个 pill。

- [ ] **Step 1: 写失败测试**

在 `test/contract.mjs` 的「浏览器半边」一节里、`check('sessionIdOf 找不到主视图会话时返回 undefined（交给宿主回落）', ...)` 之后插入：

```js
// 角色页面状态：由宿主 /roles 的返回推导，缺字段时不能崩。
const roleStatusOf = loaded.factory(requireFor(true)).roleStatusOf
check('roleStatusOf 被导出（契约的一部分）', typeof roleStatusOf === 'function')
check('roleStatusOf 认 unassigned', roleStatusOf({ status: 'unassigned' }) === 'unassigned')
check('roleStatusOf 认 matched', roleStatusOf({ status: 'matched' }) === 'matched')
check('roleStatusOf 认 drifted', roleStatusOf({ status: 'drifted' }) === 'drifted')
check('roleStatusOf 认不出的值退回 unassigned', roleStatusOf({ status: '瞎写的' }) === 'unassigned')
check('roleStatusOf 对垃圾输入不抛', roleStatusOf(null) === 'unassigned' && roleStatusOf('x') === 'unassigned' && roleStatusOf({}) === 'unassigned')
```

同时，在「三个页签都在」这条断言上加到既有渲染检查里（紧跟已有的 `tree = sectionEntry.component({})` 那段之后）：

```js
const sectionTexts = collectTexts(tree)
check('三个页签的文案都渲染出来了', sectionTexts.includes('角色') && sectionTexts.includes('技能') && sectionTexts.includes('技能仓库'), sectionTexts.join('|').slice(0, 200))
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `node dsh-plugin/test/contract.mjs`
Expected: FAIL —— `roleStatusOf is not a function`，以及「三个页签」那条失败。

- [ ] **Step 3: 补词条**

`lib/client.js` 的 zh 词典（`'tab.repos': '技能仓库',` 之后）加：

```js
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
				'roles.activateConfirm': '切换会把当前项目的技能对齐到这个角色：启用 {enable} 个、停用 {disable} 个。全局技能不受影响。确定吗？',
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
				'roles.activateSummary': '启用 {enable} 个 / 停用 {disable} 个 / 跳过 {skipped} 个',
				'roles.takeover': '「{name}」停用后有同名技能接管生效',
				'roles.resultOk': '完成',
				'roles.resultSkipped': '跳过',
				'roles.resultFailed': '失败',
				'roles.loadFailed': '读不到角色列表',
				'roles.saveFailed': '保存失败',
				'roles.activateFailed': '切换失败',
```

en 词典（`'tab.repos': 'Repositories',` 之后）加**同名键**：

```js
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
				'roles.activateConfirm': 'Switching aligns this project\'s skills to the role: {enable} enabled, {disable} disabled. Global skills are unaffected. Continue?',
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
				'roles.activateSummary': '{enable} enabled / {disable} disabled / {skipped} skipped',
				'roles.takeover': 'After disabling "{name}", a same-named skill takes over',
				'roles.resultOk': 'done',
				'roles.resultSkipped': 'skipped',
				'roles.resultFailed': 'failed',
				'roles.loadFailed': 'Could not read the role list',
				'roles.saveFailed': 'Save failed',
				'roles.activateFailed': 'Switch failed',
```

- [ ] **Step 4: 加 `roleStatusOf` 与第三个 pill**

在 `sessionIdOf` 函数之前加：

```js
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
```

`SkillConsoleSection` 里加第三个 pill，并让 tab 分支多一条：

```js
					h(UiPill, { active: tab === 'roles', onClick: () => setTab('roles'), children: t('tab.roles') }),
```

```js
				tab === 'skills'
					? h(PanelBoundary, { key: 'skills' }, h(SkillsPanel, { t, sessionId }))
					: tab === 'repos'
						? h(PanelBoundary, { key: 'repos' }, h(ReposPanel, { t, sessionId }))
						: h(PanelBoundary, { key: 'roles' }, h(RolesPanel, { t, sessionId })),
```

底部导出面加 `roleStatusOf`：

```js
		exports.roleStatusOf = roleStatusOf
```

> 此时 `RolesPanel` 还不存在。**本步骤先放一个占位渲染保证能跑通**——下一任务会把它整个替换掉：

```js
		/** 角色面板（Task 6 填充；先给一个不崩的空壳，保证 tab 能切）。 */
		function RolesPanel(props) {
			return h('div', { className: 'sc-body' }, t('roles.empty'))
		}
```

- [ ] **Step 5: 跑测试，确认通过**

Run: `node dsh-plugin/test/contract.mjs`
Expected: 全绿，失败 0。

---

## Task 6: `RolesPanel` / `RoleEditor` / `RoleRow`

**Files:**
- Modify: `dsh-plugin/lib/client.js`（替换 Task 5 的占位 `RolesPanel`，新增 `RoleRow` / `RoleEditor` / 样式）
- Modify: `dsh-plugin/test/contract.mjs`

**Interfaces:**
- Consumes: Task 5 的词条与 `roleStatusOf`；现有的 `apiGet` / `apiPost` / `actionError` / `askConfirm` / `UiButton` / `UiPill` / `UiTag` / `UiSwitch`。
- Produces: 客户端导出 `RoleRow`、`RoleEditor`。

- [ ] **Step 1: 写失败测试**

在 Task 5 新增的那几条 `roleStatusOf` 断言之后插入：

```js
// 角色明细行：状态徽标与技能数必须来自数据，而不是写死。
const RoleRowExport = loaded.factory(requireFor(true)).RoleRow
const RoleEditorExport = loaded.factory(requireFor(true)).RoleEditor
check('RoleRow 被导出（契约的一部分）', typeof RoleRowExport === 'function')
check('RoleEditor 被导出（契约的一部分）', typeof RoleEditorExport === 'function')

const roleRowTree = RoleRowExport({
	t: tStub,
	role: { id: 'r1', name: '前端', skills: ['a', 'b'], updatedAt: 1, active: true },
	status: 'matched',
	busy: false,
	onActivate: () => {},
	onEdit: () => {},
	onRemove: () => {},
})
check('RoleRow 渲染出角色名', collectTexts(roleRowTree).includes('前端'), collectTexts(roleRowTree).join('|').slice(0, 160))
check('RoleRow 把技能数讲出来', collectTexts(roleRowTree).some((text) => text.includes('skillsCount')), collectTexts(roleRowTree).join('|').slice(0, 160))

const roleEditorTree = RoleEditorExport({
	t: tStub,
	draft: { id: null, name: '新角色', skills: ['rp-alpha'] },
	candidates: {
		project: [{ name: 'rp-alpha', path: '/p/rp-alpha/SKILL.md', enabled: true, toggleable: true, readOnlyReason: null }],
		global: [{ name: 'rp-global', path: '/g/rp-global/SKILL.md', enabled: true, toggleable: true, readOnlyReason: null, readOnly: true, reason: 'global-uncontrollable' }],
	},
	missing: [],
	busy: false,
	onName: () => {},
	onToggle: () => {},
	onSave: () => {},
	onCancel: () => {},
	onActivate: () => {},
})
check('RoleEditor 为全局技能渲染只读说明', collectTexts(roleEditorTree).some((text) => text.includes('globalReadonly')), collectTexts(roleEditorTree).join('|').slice(0, 200))
check('RoleEditor 把可勾选的项目技能渲染出来', collectTexts(roleEditorTree).some((text) => text.includes('rp-alpha')), collectTexts(roleEditorTree).join('|').slice(0, 160))
check('RoleEditor 列出角色里缺失的技能', collectTexts(RoleEditorExport({ t: tStub, draft: { id: 'r', name: 'x', skills: ['gone'] }, candidates: { project: [], global: [] }, missing: ['gone'], busy: false, onName: () => {}, onToggle: () => {}, onSave: () => {}, onCancel: () => {}, onActivate: () => {} })).some((text) => text.includes('gone')))

const rolesReadme = readFileSync(join(LIB, 'client.js'), 'utf8')
check('角色面板不复用全局根的写路径（不在客户端拼 applyRole 的入参）', !/applyRole/.test(rolesReadme))
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `node dsh-plugin/test/contract.mjs`
Expected: FAIL —— `RoleRow is not a function`。

- [ ] **Step 3: 实现三个组件**

把 Task 5 的占位 `RolesPanel` 整个替换成下面这一块（放在 `ReposPanel` 之后、`sessionIdOf` 之前）：

```js
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

			const nameInput = h(UiInput, {
				value: draft.name ?? '',
				placeholder: t('roles.namePlaceholder'),
				disabled: props.busy,
				onChange: (value) => props.onName(value),
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

			/** 把一份角色转成草稿。 */
			const draftOf = (role) => ({ id: role.id, name: role.name, skills: [...(role.skills ?? [])] })

			const current = draft ?? { id: null, name: '', skills: [] }
			const missingInDraft = current.skills.filter((name) => !(data.candidates?.project ?? []).some((skill) => skill.name === name))

			/** 准备一份「将启用 M / 停用 N」的确认文案（按草稿本地算，不为了弹窗再打一次接口）。 */
			const confirmText = () => {
				const picked = new Set(current.skills)
				const enable = (data.candidates?.project ?? []).filter((skill) => picked.has(skill.name) && skill.enabled !== true).length
				const disable = (data.candidates?.project ?? []).filter((skill) => !picked.has(skill.name) && skill.enabled === true).length
				return t('roles.activateConfirm', { enable, disable })
			}

			const runActivate = (roleId) => {
				if (!askConfirm(confirmText())) return
				setBusy(true)
				apiPost('/roles/activate', { id: roleId }, props.sessionId)
					.then((result) => {
						const failed = (result.results ?? []).filter((entry) => entry.ok !== true)
						const takeover = result.takeover ?? []
						const lines = [t('roles.activateSummary', { enable: result.changed, disable: 0, skipped: failed.length })]
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
					h('span', { className: 'sc-spacer' }),
					h(UiButton, { disabled: busy, onClick: () => setDraft({ id: null, name: '', skills: [] }) }, t('roles.new')),
					status === 'unassigned' ? null : h(UiButton, { disabled: busy, onClick: runDeactivate }, t('roles.deactivate')),
				),
				status === 'drifted' ? h('span', { className: 'sc-sub' }, t('roles.statusDriftedHint')) : null,
				error === null ? null : h('span', { className: 'sc-role-error' }, error),
				notice === null ? null : h('span', { className: 'sc-role-notice' }, notice),
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
						onActivate: current.id === null ? null : () => runActivate(current.id),
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
									onActivate: () => runActivate(role.id),
									onEdit: () => setDraft(draftOf(role)),
									onRemove: () => runRemove(role),
								}),
							),
					),
			)
		}
```

样式追加到 `CSS` 常量末尾（只用官方令牌）：

```css
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
```

底部导出面加两个组件：

```js
		exports.RoleRow = RoleRow
		exports.RoleEditor = RoleEditor
```

- [ ] **Step 4: 跑测试，确认通过**

Run: `node dsh-plugin/test/contract.mjs`
Expected: 全绿，失败 0。若「zh 与 en 的键集完全一致」失败，逐键补齐两种语言。

- [ ] **Step 5: 人工看一眼真实渲染**

重启 DSH Desktop → 设置 →「技能控制台」→「角色」。此时应能看到：当前项目名、状态徽标、`新建角色`、空列表提示。新建一个角色、勾两个项目技能、保存、切换（弹确认）。全局技能那栏必须是灰的、没有开关。

---

## Task 7: 文档、版本、真 cordis 与冒烟

**Files:**
- Modify: `dsh-plugin/package.json`、`docs/HTTP-API.md`、`README.md`、`docs/readme/roles.md`
- Modify: `dsh-plugin/test/integration-cordis.mjs`、`dsh-plugin/test/smoke.mjs`

**Interfaces:**
- Consumes: Task 1–6 的全部产物。

- [ ] **Step 1: 版本号**

`dsh-plugin/package.json`：`"version": "0.2.1"` → `"version": "0.3.0"`。

- [ ] **Step 2: 真 cordis 集成加一条**

`test/integration-cordis.mjs` 的第 4 个用例之后插入：

```js
// 5) 角色读端点也必须能在真 cordis 下跑通（它比 /state 多读一个 sessions 之外的东西：角色状态文件）。
const rolesUnderCordis = await runUnderCordis({
	provideServices: {},
	request: { path: '/api/skill-console/roles' },
})
check('真 cordis 下 GET /roles 返回 200 JSON 壳', rolesUnderCordis?.status === 200 && rolesUnderCordis?.body?.ok === true, `${rolesUnderCordis?.status} ${String(rolesUnderCordis?.body).slice(0, 200)}`)
check('GET /roles 带回三个契约字段', typeof rolesUnderCordis?.body?.data?.status === 'string' && Array.isArray(rolesUnderCordis?.body?.data?.roles) && typeof rolesUnderCordis?.body?.data?.candidates === 'object')
```

> 注意：本用例会**读真实 `DSH_HOME` 下的 `roles.json`**（因为 `runUnderCordis` 没设 `DSH_HOME`，回落 `~/.dsh`）。文件不存在时是空状态，不会写盘；`GET /roles` 本身不写任何东西。跑完检查一下 `~/.dsh/skill-console/` 有没有多出文件——不该有。

- [ ] **Step 3: 冒烟测试加一节（**必须是非破坏性的**）**

在 `test/smoke.mjs` 的 `section('4. 与已装技能管理器共存')` 之前插入：

```js
	section('4. 角色：非破坏性往返')
	// 为什么**不**在这里测真实的角色切换：`activate` 会把项目技能根里「角色外」的
	// 技能全部停用，而冒烟测试打的是用户真实的工作区。为了测一个接口把用户的技能
	// 关掉一批，代价完全不成比例。所以这里只走「读了什么都不改」的路径：
	//   1. 用当前**已启用**的项目技能拼一个角色（切换它 = 零动作）；
	//   2. activate 它，断言 changed === 0（既验证了写路径，又保证盘上一个字节没动）；
	//   3. deactivate + remove 收尾。
	// 真正的对齐语义由 contract.mjs 在临时目录里覆盖，另有 README 的手工验收清单。
	const roleFixtureName = 'zz-skill-console-smoke-role'
	const rolesBefore = await call('/api/skill-console/roles', { headers: sessionHeader(sessionId) })
	check('GET /roles 返回 200', rolesBefore.status === 200 && rolesBefore.body?.ok === true, `http=${rolesBefore.status}`)
	check('角色列表是数组', Array.isArray(rolesBefore.body?.data?.roles))
	check('候选里项目技能与全局技能分开', Array.isArray(rolesBefore.body?.data?.candidates?.project) && Array.isArray(rolesBefore.body?.data?.candidates?.global))
	check('全局技能一律标只读', (rolesBefore.body?.data?.candidates?.global ?? []).every((entry) => entry.readOnly === true && entry.reason === 'global-uncontrollable'))
	if (rolesBefore.body?.data?.roles?.some((role) => role.name === roleFixtureName)) {
		console.error(`\n同名角色已存在，拒绝覆盖：${roleFixtureName}`)
		console.error('请先在面板里删除它，或手工编辑 roles.json 后重跑。')
		process.exit(3)
	}

	const enabledProjectSkills = (rolesBefore.body?.data?.candidates?.project ?? []).filter((entry) => entry.enabled === true && entry.toggleable === true)
	if (enabledProjectSkills.length === 0) {
		console.log('  跳过：本项目没有已启用的技能可用来拼零动作角色')
	} else {
		const saved = await call('/api/skill-console/roles/save', {
			method: 'POST',
			headers: { ...WRITE_HEADERS, ...sessionHeader(sessionId) },
			body: JSON.stringify({ name: roleFixtureName, skills: enabledProjectSkills.map((entry) => entry.name) }),
		})
		check('POST /roles/save 建角色成功', saved.status === 200 && typeof saved.body?.data?.role?.id === 'string', JSON.stringify(saved.body).slice(0, 160))
		const roleFixtureId = saved.body?.data?.role?.id

		const preview = await call(`/api/skill-console/roles/preview?role=${encodeURIComponent(roleFixtureId)}`, { headers: sessionHeader(sessionId) })
		check('GET /roles/preview 返回 200 且零动作', preview.status === 200 && preview.body?.data?.steps?.length === 0, JSON.stringify(preview.body?.data?.steps).slice(0, 200))

		const activated = await call('/api/skill-console/roles/activate', {
			method: 'POST',
			headers: { ...WRITE_HEADERS, ...sessionHeader(sessionId) },
			body: JSON.stringify({ id: roleFixtureId }),
		})
		check('POST /roles/activate 返回 200', activated.status === 200 && activated.body?.ok === true, JSON.stringify(activated.body).slice(0, 200))
		check('零动作切换没有改任何文件（changed === 0）', activated.body?.data?.changed === 0, String(activated.body?.data?.changed))
		check('零动作切换后状态是 matched', activated.body?.data?.status === 'matched', String(activated.body?.data?.status))

		const cleared = await call('/api/skill-console/roles/deactivate', { method: 'POST', headers: { ...WRITE_HEADERS, ...sessionHeader(sessionId) }, body: '{}' })
		check('POST /roles/deactivate 返回 200', cleared.status === 200 && cleared.body?.ok === true, JSON.stringify(cleared.body).slice(0, 160))
		const removed = await call('/api/skill-console/roles/remove', { method: 'POST', headers: { ...WRITE_HEADERS, ...sessionHeader(sessionId) }, body: JSON.stringify({ id: roleFixtureId }) })
		check('POST /roles/remove 返回 200', removed.status === 200 && removed.body?.ok === true, JSON.stringify(removed.body).slice(0, 160))
		check('角色已清干净', (await call('/api/skill-console/roles', { headers: sessionHeader(sessionId) })).body?.data?.roles?.every((role) => role.name !== roleFixtureName) === true)
	}
```

- [ ] **Step 4: 跑离线测试**

Run: `node dsh-plugin/test/contract.mjs`
Expected: 全绿，失败 0（版本号变更不影响任何断言）。

- [ ] **Step 5: 跑真 cordis 集成**

Run: `node dsh-plugin/test/integration-cordis.mjs`
Expected: 全绿（装了 DSH Desktop 的机器上）。跑完确认 `~/.dsh/skill-console/` 下没有多出 `roles.json`。

- [ ] **Step 6: `docs/HTTP-API.md` 补 6 个端点**

在既有端点表里追加（保持该文件现有的表格与字段说明风格，逐字给出请求/响应形状）：

| 方法 | 路径 | 写 | 请求 | 响应 `data` |
| --- | --- | --- | --- | --- |
| GET | `/roles` | 否 | `?project=<sessionId>` 或 `x-skill-console-session` 头 | `{roles, active, project, status, stats, candidates}` |
| GET | `/roles/preview` | 否 | `?role=<id>` | `{role, status, steps, noop, skipped, missing, stats}` |
| POST | `/roles/save` | 是 | `{id?, name, skills[]}` | `{role}` |
| POST | `/roles/remove` | 是 | `{id}` | `{removed, clearedProjects}` |
| POST | `/roles/activate` | 是 | `{id}` | `{role, status, results, changed, takeover}` |
| POST | `/roles/deactivate` | 是 | `{}` | `{cleared}` |

新增错误码：`error.role.state(500)`、`error.role.unknown(404)`、`error.role.name(400)`、`error.role.duplicate(409)`、`error.role.tooMany(400)`、`error.role.skills(400)`、`error.role.noProject(400)`。

同时把文件顶部「13 个端点」的计数与 README 第 161 行的同一个数字一起改成新的总数。**不要照抄本计划里的数字**：先打开 `lib/routes.js` 数一遍 `READ_ROUTES` + `WRITE_ROUTES` 的实际条数（读代码时是 6 + 8 = 14，而 README 原本写的「13 个端点」与它对不上——顺手核对并改正），加 6 个新端点后写你改完的真实条数。

- [ ] **Step 7: `README.md`**

- 第 26 行 `### 技能 tab` 之后加一节 `### 角色 tab`，写清：角色是全局共享的命名组合；切换严格对齐项目技能根；全局技能不受控制（这是硬边界）；编辑是草稿、只有切换落盘；漂移不自动纠正。
- 第 49 行的「三条设计边界」改成「四条」，第 4 条：**角色切换只写项目技能根，全局根在结构上不可达**（两个根只有展示与接管报告时同时出现，`applyRole` 只接受单个根）。
- 「已知边界」补两条：① 全局技能无法被角色排除，角色停用项目副本后全局同名技能会接管；② `client.js` 单文件超过 2000 行是 DSH 加载机制的结构性代价（`dsh.client` 只服务一个文件、无构建步骤），不是可以随手拆的模块。
- 模块图加一行 `roles.js`；文档索引处（第 163 行附近）把 `docs/readme/roles.md` 那条改成同时指向 `docs/readme/roles-plan.md`。

- [ ] **Step 8: 更新 `docs/readme/roles.md`**

- 顶部状态改成「已实现（`dsh-skill-console@0.3.0`）」。
- §9 里「smoke.mjs：扩一次真实的角色切换往返——建一个临时项目技能根，切成角色、读回状态、还原」这句**是错的**：冒烟测试打的是真实工作区，没有「临时项目技能根」。改成 Task 7 Step 3 描述的零动作方案，并说明真正的对齐语义由 contract 在临时目录里覆盖。
- §10 的版本号已经是 `0.3.0`，核对一遍即可。

- [ ] **Step 9: 收尾跑一遍全部**

```bash
cd /Users/zhanbaiyang/Documents/code/ai/agents/dsh/skill-console
node dsh-plugin/test/contract.mjs
node dsh-plugin/test/integration-cordis.mjs
node dsh-plugin/test/smoke.mjs
```

Expected: 前两条全绿；第三条需要装好并**重启过**的 DSH，全绿。三条都要贴出「N/N 项通过」。

---

## Self-Review

**1. Spec 覆盖**

| `docs/readme/roles.md` 的节 | 落在哪个任务 |
| --- | --- |
| §2 三条前提（全局共享 / 严格对齐 / 重命名对齐） | Task 2（`planRole` 的语义）、Task 4（`rolesActivate`） |
| §3 全局技能无法被角色排除 | Task 4（`candidates.global` 的 `readOnly` / `reason`）、Task 6（只读栏 + 说明文案）、Task 7（README 已知边界） |
| §4 数据模型与存储 | Task 1 |
| §5 `lib/roles.js` 三个导出与两层结构保证 | Task 1 / 2 / 3 |
| §6 6 个端点、响应形状、错误码 | Task 4、Task 7 Step 6 |
| §7 客户端第三个 tab 与单文件增长的取舍 | Task 5（tab）、Task 6（面板）、Task 7 Step 7（README 已知边界） |
| §8 边角处置表 | 同名双副本（Task 2）、missing（Task 2/6）、漂移（Task 4/6）、激活角色被删（Task 1 的 `activeFor` 只在角色仍存在时返回）、软链接（Task 2/3）、接管报告（Task 4） |
| §9 三层测试计划 | Task 1–6（contract）、Task 7 Step 2（cordis）、Task 7 Step 3（smoke，方案已修正） |
| §10 文档与版本 | Task 7 |
| §11 明确不做的事 | 计划里没有快照/回滚、没有目录腾挪、没有自动对齐——只有显式点击才落盘 |

**2. 占位符扫描**：无 TBD / TODO；每个代码步骤都给完整代码。Task 5 Step 4 的占位 `RolesPanel` 是**刻意的**，并在 Task 6 Step 3 明确要求整个替换，不是遗留占位符。

**3. 类型一致性**：`planRole` 返回的 `steps[].target` 被 `applyRole` 当 `toggleSkill` 的 `enabled` 用；`applyRole` 返回 `results[].changed` 被 Task 4 用来决定要不要 `notifyFileChanged`；`roleStore.remove` 返回 `{removed, clearedProjects}` 与 Task 4/7 的断言一致；`roleStatusOf` 只认 `matched`/`drifted`，Task 4 的 `statusOf` 产出这三个值外加 `unassigned`，一致；词条键 `roles.statusMatched` / `roles.statusDrifted` / `roles.statusUnassigned` 在 `roleStatusKey` 与 DICT 里同名同拼写。

**4. 已知的遗留**：`RoleEditor` 的 `onActivate` 在新建（`draft.id === null`）时会传空 id，宿主回 400 `error.proto.missingId` —— 这是**刻意的**：还没保存的角色没有可切换的身份，界面应当先 `保存`。人工验收时确认这条提示是可读的错误文案，而不是白屏。
