/**
 * 技能根解析、目录扫描与「开启/关闭」。
 *
 * 这一层只做三件事，且都在**宿主进程**里用 `node:fs` 完成：
 *
 *   1. 把技能根解析成绝对路径（全局 1 个 + 当前项目 1 个，都在 DSH_HOME/项目根下的 `.dsh/skills`）。
 *   2. 按 DSH 自己的发现规则扫描根目录，得到一个技能清单。
 *   3. 用**重命名发现文件**的方式启用/停用技能——绝不改写、绝不删除内容。
 *
 * 为什么不用 `ctx.fs`：`dsh-fs-sandbox` 的默认策略是 `workspace-write`，
 * 写 `~/.dsh/skills` 这类工作区外的路径会抛 `FS_SANDBOX_DENIED`。宿主插件的
 * `apply()` 跑在宿主进程里（不是会话的工具执行面），所以这里直接用 `node:fs`。
 * 这是宿主插件本来的权限面，不是绕过沙箱。
 *
 * 发现规则严格对齐 `@deepseek-ai/dsh-skill-filesystem`（否则就会出现
 * 「面板里看得见、Agent 看不见」这种最坏的不一致）：
 *
 *   - 只扫一层：`<root>/<name>/SKILL.md`（目录包）或 `<root>/<name>.md`（扁平文件）
 *   - 文件名大小写敏感；嵌套的 `**\/SKILL.md` 永远不会被发现
 *   - 以 `.` 开头的条目一律跳过（`.system` / `.trash` / `.DS_Store` …）
 *   - 符号链接跟随（`stat` 语义），因此指向目录的软链会当目录包处理——
 *     但**不允许对它启停**（重命名会改到链接目标里去）
 *
 * 与 DSH 不同的**唯一**一处（刻意的）：发现文件带 `.disabled` 后缀时仍然被扫描，
 * 只是标记为「已停用」。这正是关闭技能的实现方式——文件还在，DSH 的 provider
 * 看不见它（它只认精确的 `SKILL.md` / `*.md`）。
 *
 * frontmatter 的解析与诊断码在 `frontmatter.js` / `diagnostics.js`，本文件只负责
 * 文件系统这一侧。
 */

import { randomUUID } from 'node:crypto'
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'

import { DIAGNOSTIC, READ_ERROR } from './diagnostics.js'
import { describeFrontmatter, isValidSkillName, splitFrontmatter } from './frontmatter.js'
import { httpError } from './http.js'
// 目标路径只认 rows.js 的那一份实现，避免这里再写第二套「目录包 vs 扁平」的解析。
import { targetPathFor } from './rows.js'

/** 发现文件的两种形态。 */
export const DISCOVERY_FILE = 'SKILL.md'
export const DISABLED_SUFFIX = '.disabled'

/** 两个技能根的定义（顺序即 `/catalog` 的返回顺序）。 */
export const ROOT_DEFS = [
	{ key: 'user-dsh', scope: 'global', label: '全局 DSH', rank: 400, kind: 'user-dsh' },
	{ key: 'project-dsh', scope: 'project', label: '项目 DSH', rank: 100, kind: 'project-dsh' },
]

/** 空串/纯空白视为未设置。 */
function blank(value) {
	return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** 本地错误文本（这里不需要 HTTP 语义，单独留一个，避免绕道 http.js）。 */
function errorTextOf(error) {
	return error instanceof Error ? error.message : String(error)
}

/**
 * 解析 DSH_HOME。
 *
 * 与 `@deepseek-ai/dsh-skill-filesystem` 的 `resolveDshHome` 同序：
 * `$DSH_HOME`（空白视为未设置）→ `~/.dsh`。DSH Desktop 的 DSH_HOME 是
 * `~/Library/Application Support/dsh-desktop/harness`，与 `~/.dsh` **不是**同一处——
 * 所以这里必须读环境变量，不能写死。
 *
 * `.agents`（`$DSH_AGENTS_HOME` / `~/.agents`）**不再**是本插件的技能根：
 * 面板只管 DSH 自己的技能目录，不再加载 `.agents/skills`。
 *
 * @param env - 环境变量表（测试可注入）。
 * @returns 已 resolve 的绝对路径。
 */
export function resolveDshHome(env = process.env) {
	const dshHome = blank(env.DSH_HOME) ?? join(homedir(), '.dsh')
	return resolve(dshHome)
}

/**
 * 项目根：从 cwd 向上找第一个含 `.git` 的目录；一路到根都没有就退回 cwd。
 * 与 `dsh-skill-filesystem` 的 `findProjectRoot` 同语义（普通文件夹也能用，不要求 git init）。
 * @param cwd - 会话工作目录。
 * @returns 绝对路径；cwd 非法时返回 null。
 */
export function findProjectRoot(cwd) {
	const start = blank(cwd)
	if (start === undefined) return null
	let current = resolve(start)
	for (;;) {
		if (existsSync(join(current, '.git'))) return current
		const parent = dirname(current)
		if (parent === current) return resolve(start)
		current = parent
	}
}

/**
 * 解析当前请求能看到的所有技能根。
 * @param options - `{dshHome, projectCwd}`。
 * @returns 两个（或只有全局那个）根描述：`{key, scope, label, rank, path, exists, writable}`。
 */
export function resolveRoots({ dshHome, projectCwd }) {
	const projectRoot = findProjectRoot(projectCwd)
	const paths = {
		'user-dsh': join(dshHome, 'skills'),
		'project-dsh': projectRoot ? join(projectRoot, '.dsh', 'skills') : undefined,
	}
	const roots = []
	for (const def of ROOT_DEFS) {
		const path = paths[def.key]
		if (path === undefined) continue
		roots.push({
			key: def.key,
			scope: def.scope,
			label: def.label,
			rank: def.rank,
			path,
			exists: existsSync(path),
			// 两个根都可写：项目根可写正是本插件与只管用户级技能的管理器的区别。
			writable: true,
		})
	}
	return roots
}

/** 路径是否落在某个根内（含根本身）。 */
export function isInside(rootPath, targetPath) {
	const root = resolve(rootPath)
	const target = resolve(targetPath)
	return target === root || target.startsWith(root + sep)
}

/**
 * 把一个发现文件分类到某个根。
 *
 * 只承认 DSH 会发现的那两种位置（深度 1 的 `*.md`、深度 2 的 `SKILL.md`），
 * 于是「重命名」这个写操作的作用面被限制在扫描器真正会读的文件上——
 * 传进来一个 `../../../etc/passwd` 只会得到 null，而不是一次 rename。
 *
 * @param roots - `resolveRoots()` 的结果。
 * @param filePath - 候选绝对路径。
 * @returns `{root, kind, depth, enabled, directory}` 或 null。
 */
export function classifyDiscoveryPath(roots, filePath) {
	const target = resolve(filePath)
	for (const root of roots) {
		if (!isInside(root.path, target)) continue
		const relative = target.slice(root.path.length + 1)
		const parts = relative.split(sep)
		const name = parts[parts.length - 1]
		if (parts.length === 1) {
			const enabled = name.endsWith('.md')
			const disabled = name.endsWith(`.md${DISABLED_SUFFIX}`)
			if (!enabled && !disabled) return null
			return { root, kind: 'flat', depth: 1, enabled, directory: root.path }
		}
		if (parts.length === 2) {
			if (name === DISCOVERY_FILE) return { root, kind: 'directory', depth: 2, enabled: true, directory: dirname(target) }
			if (name === DISCOVERY_FILE + DISABLED_SUFFIX) {
				return { root, kind: 'directory', depth: 2, enabled: false, directory: dirname(target) }
			}
			return null
		}
		return null
	}
	return null
}

/**
 * 读一个技能（含已停用状态）。
 *
 * @param filePath - 发现文件的绝对路径（可能是 `.disabled`）。
 * @param options - `{roots, withBody}`：给了 `roots` 就校验路径确实在某个根内；
 *   `withBody` 为 true 时额外带上 `frontmatter`（围栏内原文）与 `body`。
 *   扫描路径**不要**开 `withBody`——一次目录扫描没必要把所有正文读进内存。
 * @returns 技能记录。
 * @throws `{code, statusCode}` 形状的错误（宿主路由直接转成 JSON）。
 */
export function readSkill(filePath, options = {}) {
	const target = resolve(filePath)
	const classified = options.roots ? classifyDiscoveryPath(options.roots, target) : null
	if (options.roots && classified === null) {
		throw httpError(400, 'error.path.outsideRoots', `路径不在已知技能根内：${target}`)
	}
	if (!existsSync(target)) throw httpError(404, 'error.skill.notFound', `找不到技能文件：${target}`)
	const stat = statSync(target)
	// 软链接：内容属于别的仓库/目录，重命名会改到那边去——只读展示，不允许启停。
	const linked = lstatSync(target).isSymbolicLink() || (classified?.kind === 'directory' && lstatSync(classified.directory).isSymbolicLink())
	const raw = readFileSync(target, 'utf8')
	const record = buildSkillRecord({
		path: target,
		directory: classified?.directory ?? dirname(target),
		kind: classified?.kind ?? 'flat',
		enabled: classified?.enabled ?? !target.endsWith(DISABLED_SUFFIX),
		root: classified?.root ?? null,
		raw,
		linked,
		stat,
	})
	if (options.withBody === true) {
		const split = splitFrontmatter(raw)
		record.frontmatter = split.yaml
		record.body = split.body.trim()
	}
	return record
}

/**
 * 由文件内容组装技能记录（扫描与单读共用一份口径，避免两处漂移）。
 * @param input - `{path, directory, kind, enabled, root, raw, linked, stat}`。
 * @returns 技能记录。
 */
function buildSkillRecord({ path, directory, kind, enabled, root, raw, linked, stat }) {
	const described = describeFrontmatter(raw)
	const diagnostics = [...described.diagnostics]
	const declaredName = described.declaredName
	const fallbackName = kind === 'directory' ? basename(directory) : basename(path).replace(/\.disabled$/, '').replace(/\.md$/, '')
	const name = declaredName !== null && isValidSkillName(declaredName) ? declaredName : fallbackName
	if (linked) diagnostics.push(DIAGNOSTIC.symlink)

	return {
		name,
		declaredName,
		description: described.description,
		path,
		directory,
		kind,
		enabled,
		root: root ? root.key : null,
		scope: root ? root.scope : null,
		diagnostics,
		// 软链接的技能不允许启停：重命名会落到链接目标的仓库里，那不是本插件的写入面。
		toggleable: !linked,
		readOnlyReason: linked ? 'symlink' : null,
		size: stat?.size ?? raw.length,
		mtimeMs: stat?.mtimeMs ?? null,
		// 仓库订阅信息由路由层补（它才持有订阅状态）。
		installed: null,
	}
}

/**
 * 扫描一个技能根。
 *
 * 条目顺序用 `localeCompare`（与 DSH provider 一致），但**排序结果不参与任何
 * 优先级判断**——同名技能谁生效由 DSH 的 scope/rank 决定，本插件只负责把它讲清楚。
 *
 * @param root - `resolveRoots()` 里的一个根。
 * @returns `{skills, warning}`；根不存在时 `skills` 为空。
 */
export function scanRoot(root) {
	if (!existsSync(root.path)) return { skills: [], warning: null }
	let entries
	try {
		entries = readdirSync(root.path, { withFileTypes: false })
	} catch (error) {
		return { skills: [], warning: { code: 'error.root.read', message: `${root.path}: ${errorTextOf(error)}` } }
	}
	const skills = []
	for (const entry of entries.sort((a, b) => a.localeCompare(b))) {
		if (entry.startsWith('.')) continue
		const entryPath = join(root.path, entry)
		let stat
		try {
			stat = statSync(entryPath)
		} catch {
			// 断链的软链等：DSH 也读不到，跳过即可，不是错误。
			continue
		}
		if (stat.isDirectory()) {
			const enabledFile = join(entryPath, DISCOVERY_FILE)
			const disabledFile = enabledFile + DISABLED_SUFFIX
			const target = existsSync(enabledFile) ? enabledFile : existsSync(disabledFile) ? disabledFile : null
			if (target === null) continue
			skills.push(scanOne(root, target, entryPath, 'directory', !target.endsWith(DISABLED_SUFFIX)))
			continue
		}
		if (stat.isFile()) {
			if (entry.endsWith('.md') && entry !== DISCOVERY_FILE) {
				skills.push(scanOne(root, entryPath, root.path, 'flat', true))
			} else if (entry.endsWith(`.md${DISABLED_SUFFIX}`)) {
				skills.push(scanOne(root, entryPath, root.path, 'flat', false))
			}
		}
	}
	return { skills, warning: null }
}

/** 扫一个条目并容错（单个坏文件不该让整次扫描失败）。 */
function scanOne(root, target, directory, kind, enabled) {
	try {
		const stat = statSync(target)
		const raw = readFileSync(target, 'utf8')
		const linked = lstatSync(target).isSymbolicLink() || lstatSync(directory).isSymbolicLink()
		return buildSkillRecord({ path: target, directory, kind, enabled, root, raw, linked, stat })
	} catch (error) {
		return {
			name: basename(directory),
			declaredName: null,
			description: null,
			path: target,
			directory,
			kind,
			enabled,
			root: root.key,
			scope: root.scope,
			diagnostics: [READ_ERROR],
			toggleable: false,
			readOnlyReason: errorTextOf(error),
			size: 0,
			mtimeMs: null,
			installed: null,
		}
	}
}

/**
 * 计算同一个技能名在多个根之间的覆盖关系。
 *
 * 只统计**已启用**的副本——被停用的副本本来就不参与加载。
 *
 * @param roots - `[{key, label, scope, skills}]`。
 * @returns `[{name, winner, shadowed}]`，winner 取「项目 scope 优先，其余按列表顺序」。
 */
export function findCollisions(roots) {
	const byName = new Map()
	for (const root of roots) {
		for (const skill of root.skills ?? []) {
			if (!skill.enabled) continue
			const entry = { root: root.key, label: root.label, scope: root.scope, path: skill.path }
			const list = byName.get(skill.name) ?? []
			list.push(entry)
			byName.set(skill.name, list)
		}
	}
	const collisions = []
	for (const [name, list] of byName) {
		if (list.length < 2) continue
		const ranked = [...list].sort((a, b) => rankOf(b) - rankOf(a))
		collisions.push({ name, winner: ranked[0], shadowed: ranked.slice(1) })
	}
	return collisions.sort((a, b) => a.name.localeCompare(b.name))
}

/** 更「近」的 scope 赢；同 scope 时列表顺序即优先级。 */
function rankOf(entry) {
	return entry.scope === 'project' ? 1 : 0
}

/**
 * 启用/停用一个技能：**只重命名发现文件**。
 *
 * 这是本插件唯一的破坏性写操作，所以围栏做在最前面：
 *   - 路径必须落在已知根内，且位于扫描器真正会读的位置（`classifyDiscoveryPath`）
 *   - 目标名已存在 → 409，绝不覆盖
 *   - 软链接 → 400，改它会落到别的仓库
 *
 * @param roots - `resolveRoots()` 的结果。
 * @param filePath - 当前发现文件路径。
 * @param enabled - 目标状态。
 * @returns `{path, enabled, before, changed}`。
 */
export function toggleSkill(roots, filePath, enabled) {
	const target = resolve(filePath)
	const classified = classifyDiscoveryPath(roots, target)
	if (classified === null) throw httpError(400, 'error.path.outsideRoots', `路径不在已知技能根内：${target}`)
	if (!existsSync(target)) throw httpError(404, 'error.toggle.notFound', `找不到技能文件：${target}`)
	if (classified.kind === 'directory' && lstatSync(classified.directory).isSymbolicLink()) {
		throw httpError(400, 'error.toggle.symlink', `软链接技能不允许启停（会改到链接目标）：${classified.directory}`)
	}
	if (lstatSync(target).isSymbolicLink()) {
		throw httpError(400, 'error.toggle.symlink', `软链接技能不允许启停（会改到链接目标）：${target}`)
	}
	if (classified.enabled === enabled) return { path: target, enabled, before: target, changed: false }

	const next = enabled ? target.slice(0, -DISABLED_SUFFIX.length) : target + DISABLED_SUFFIX
	if (existsSync(next)) {
		throw httpError(409, 'error.toggle.conflict', `目标文件已存在，拒绝覆盖：${next}`)
	}
	renameSync(target, next)
	// 目录包停用后目录还在（内容一个字没动），这里只回发现文件的路径。
	return { path: next, enabled, before: target, changed: true }
}

/**
 * 把一个技能从别的根复制进目标根——**只往目标写，绝不碰来源**。
 *
 * 这是继 `toggleSkill` 之后本插件第二个写盘入口，围栏比它更严：
 *   - 源必须是**可启停**的技能（软链接一律拒绝，否则会顺着链接写进别人的仓库）
 *   - 目标已存在同名 → 409，**绝不覆盖**（不能靠 `cpSync` 的 `errorOnExist`：
 *     实测它对「目标已存在且是目录」不生效，会静默合并）
 *   - 落地一律走「目标根内写 `.tmp-<uuid>` → rename 到位」，`.` 开头扫描器会跳过，
 *     中途失败也不会在目标根里留下半份技能
 *   - 源是 `.disabled` 时，复制出来的是**启用态**（去掉后缀）
 *
 * @param targetRoot - `resolveRoots()` 里的一个根（只往它写）。
 * @param sourceSkill - 扫描结果里的一条技能记录。
 * @returns `{name, path, sourcePath, kind, enabled, copied}`。
 */
export function copySkillIntoRoot(targetRoot, sourceSkill) {
	const source = resolve(String(sourceSkill?.path ?? ''))
	if (sourceSkill?.toggleable !== true) {
		throw httpError(400, 'error.transfer.symlink', `软链接技能不允许复制（会指向别的仓库）：${source}`)
	}
	if (!existsSync(source)) throw httpError(404, 'error.skill.notFound', `找不到技能文件：${source}`)
	const name = String(sourceSkill?.name ?? '')
	if (name === '') throw httpError(400, 'error.skill.notFound', `技能没有名字：${source}`)
	const kind = sourceSkill.kind === 'flat' ? 'flat' : 'directory'
	const target = targetPathFor(targetRoot.path, name, kind)
	// 「绝不覆盖」只能靠这次显式预检，`errorOnExist` 靠不住（见上）。
	if (existsSync(target)) throw httpError(409, 'error.copy.exists', `目标已存在同名技能，拒绝覆盖：${target}`)
	ensureDir(targetRoot.path)
	const token = `.tmp-${randomUUID()}`
	const temp = join(targetRoot.path, kind === 'flat' ? `${token}.md` : token)
	try {
		if (kind === 'flat') {
			cpSync(source, temp)
		} else {
			const sourceDir = resolve(String(sourceSkill.directory ?? dirname(source)))
			// `dereference: false` 显式写出：嵌套软链接原样复制成链接，不 dereference。
			cpSync(sourceDir, temp, { recursive: true, dereference: false, force: false, errorOnExist: true })
			// 源是 `.disabled` → 复制出来的是启用态。
			if (basename(source) !== DISCOVERY_FILE) {
				renameSync(join(temp, basename(source)), join(temp, DISCOVERY_FILE))
			}
		}
		renameSync(temp, target)
	} catch (error) {
		// 失败清理：尽力删掉临时产物；残留也不会被扫描器认成技能。
		rmSync(temp, { recursive: true, force: true })
		throw error
	}
	return { name, path: target, sourcePath: source, kind, enabled: true, copied: true }
}

/**
 * 纯函数：算清「删掉这个技能」到底要动哪些路径，**不碰盘**。
 *
 * 三种形态分开处置：
 *   - `flat`      只删那一个扁平文件；
 *   - `directory` 删**整个包目录**（脚本、资源都在里面）；
 *   - `symlink`   只摘链接本身（目录包是软链就摘目录链接，发现文件是软链就摘文件链接），
 *                 绝不顺着链接递归进去删别人的内容。
 *
 * 技能根**永远不删**；根之外的路径在 `classifyDiscoveryPath` 就被挡下。
 *
 * @param roots - `resolveRoots()` 的结果（围栏用）。
 * @param filePath - 发现文件绝对路径（可能是 `.disabled`）。
 * @returns `{name, path, kind, root, directory, discoveryPath, form, targets, symlinkTarget, backupTarget, backupKind}`。
 */
export function planRemoval(roots, filePath) {
	const target = resolve(filePath)
	const classified = classifyDiscoveryPath(roots, target)
	if (classified === null) throw httpError(400, 'error.path.outsideRoots', `路径不在已知技能根内：${target}`)
	if (!existsSync(target)) throw httpError(404, 'error.skill.notFound', `找不到技能文件：${target}`)
	const skill = readSkill(target, { roots })
	const directoryLinked = lstatSync(skill.directory).isSymbolicLink()
	const fileLinked = lstatSync(target).isSymbolicLink()
	const linkPath = directoryLinked ? skill.directory : fileLinked ? target : null
	if (linkPath !== null) {
		return {
			name: skill.name,
			path: target,
			kind: skill.kind,
			root: skill.root,
			directory: skill.directory,
			discoveryPath: target,
			form: 'symlink',
			targets: [linkPath],
			// 记下链接指向哪里：备份只存链接本身，恢复时按这个目标重建。
			symlinkTarget: readlinkSync(linkPath),
			backupTarget: linkPath,
			backupKind: 'symlink',
		}
	}
	const form = skill.kind === 'directory' ? 'directory' : 'flat'
	return {
		name: skill.name,
		path: target,
		kind: skill.kind,
		root: skill.root,
		directory: skill.directory,
		discoveryPath: target,
		form,
		targets: form === 'directory' ? [skill.directory] : [target],
		symlinkTarget: null,
		backupTarget: form === 'directory' ? skill.directory : target,
		backupKind: form,
	}
}

/**
 * 按 `planRemoval` 的结果动盘。**唯一**的删除入口（路由层不许自己调 `rmSync`）。
 * @param removal - `planRemoval()` 的返回值。
 * @returns `{removed, changed}`。
 */
export function removeSkill(removal) {
	for (const item of removal.targets) {
		if (removal.form === 'symlink') unlinkSync(item)
		else if (removal.form === 'directory') rmSync(item, { recursive: true, force: false })
		else unlinkSync(item)
	}
	// 备份由调用方（路由层）在此之前完成——这里只负责删。
	return { removed: removal.targets, changed: true }
}

/** 确保目录存在（安装/备份用）。 */
export function ensureDir(path) {
	mkdirSync(path, { recursive: true })
}

/**
 * 目标状态下的发现文件路径。`enabled=false` 时是 `.disabled`。
 * @param discoveryPath - 当前发现文件路径。
 * @param enabled - 目标状态。
 * @returns 绝对路径。
 */
export function discoveryPathFor(discoveryPath, enabled) {
	return enabled ? discoveryPath : discoveryPath + DISABLED_SUFFIX
}

// 诊断码表与 frontmatter 解析在 frontmatter.js / diagnostics.js 里定义，
// 这里一并对外暴露：调用方只认「扫描与诊断」这一层，不必知道内部怎么分的文件。
export { DIAGNOSTIC } from './diagnostics.js'
export { describeFrontmatter, isValidSkillName, parseFrontmatterFields, splitFrontmatter } from './frontmatter.js'
