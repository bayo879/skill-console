/**
 * 远端清单的构建：从 GitHub tree 挑出技能、算每个技能的文件、读 frontmatter 组装条目。
 *
 * 全是**纯函数**（输入 tree/内容，输出条目），不碰磁盘也不碰网络——所以能从管理器里
 * 拆出来单独测。这里的发现规则必须与 `roots.js` 的本地扫描**逐条一致**：
 * 只有深度 1 的 `<dir>/SKILL.md`（目录包）与 `<name>.md`（扁平文件）算技能，
 * 根级 `SKILL.md` 不是技能（DSH 也不认）。扁平文件还要求 frontmatter 合法——
 * 光是「一个 .md」不足以说明它是技能（见 `isManifestSkill`）。
 *
 * 两边不一致的后果很具体：面板会说「仓库里有 5 个技能」，装下来 DSH 只认 3 个。
 */

import { basename } from 'node:path'

import { describeFrontmatter, isValidSkillName } from './frontmatter.js'
import { httpError } from './http.js'

/** 一次拉取最多处理的技能条目数（防止把超大仓库当索引拖垮界面）。 */
export const MAX_SKILLS_PER_REPO = 300

/** 相对路径安全校验：安装时它会变成真实写入路径。 */
export function assertSafeRelative(relPath) {
	if (typeof relPath !== 'string' || relPath === '' || relPath.startsWith('/') || relPath.includes('..') || relPath.includes('\\')) {
		throw httpError(502, 'error.install.path', `仓库里的路径不合法，拒绝写入：${relPath}`)
	}
	return relPath
}

/**
 * 从 tree 里挑出技能条目。
 * @param tree - GitHub tree API 的 `tree` 数组。
 * @param subdirectory - 订阅配置的子目录（`''` = 仓库根）。
 * @param limit - 最多返回多少个候选。
 * @returns 候选条目：`{kind, sourcePath, dir, skillMd}`。
 */
export function collectCandidates(tree, subdirectory, limit = MAX_SKILLS_PER_REPO) {
	const base = subdirectory === '' ? '' : `${subdirectory}/`
	const candidates = []
	for (const entry of tree) {
		if (entry?.type !== 'blob' || typeof entry.path !== 'string') continue
		if (base !== '' && !entry.path.startsWith(base)) continue
		const relative = entry.path.slice(base.length)
		if (relative === '' || relative === 'SKILL.md') continue
		const directoryMatch = /^([^/]+)\/SKILL\.md$/.exec(relative)
		if (directoryMatch !== null) {
			candidates.push({ kind: 'directory', sourcePath: `${base}${directoryMatch[1]}`, dir: directoryMatch[1], skillMd: entry })
			continue
		}
		const flat = /^([^/]+)\.md$/.exec(relative)
		if (flat !== null) candidates.push({ kind: 'flat', sourcePath: entry.path, dir: null, skillMd: entry })
	}
	return candidates.slice(0, limit)
}

/** 一个候选技能在仓库里的全部文件（含 SKILL.md）。 */
export function filesOf(tree, candidate) {
	if (candidate.kind === 'flat') {
		return [{ path: basename(candidate.sourcePath), blobSha: candidate.skillMd.sha, size: candidate.skillMd.size ?? 0 }]
	}
	const prefix = `${candidate.sourcePath}/`
	const files = []
	for (const entry of tree) {
		if (entry?.type !== 'blob' || typeof entry.path !== 'string') continue
		if (!entry.path.startsWith(prefix)) continue
		const relative = entry.path.slice(prefix.length)
		if (relative === '') continue
		files.push({ path: assertSafeRelative(relative), blobSha: entry.sha, size: entry.size ?? 0 })
	}
	return files
}

/** 候选的 SKILL.md 在仓库里的路径。 */
export function skillMdPathOf(candidate) {
	return candidate.kind === 'flat' ? candidate.sourcePath : `${candidate.sourcePath}/SKILL.md`
}

/**
 * 由「候选 + 读到的 SKILL.md」组装一条清单条目。
 * @param candidate - `collectCandidates` 的结果。
 * @param raw - SKILL.md 全文；读失败时 null。
 * @param files - `filesOf` 的结果。
 * @param readError - 读失败原因。
 * @returns 清单条目。
 */
export function manifestEntryOf(candidate, raw, files, readError) {
	const fallbackName = candidate.kind === 'directory' ? candidate.dir : basename(candidate.sourcePath).replace(/\.md$/, '')
	const bytes = files.reduce((sum, file) => sum + (file.size ?? 0), 0)
	if (raw === null) {
		return {
			sourcePath: candidate.sourcePath,
			kind: candidate.kind,
			name: fallbackName,
			declaredName: null,
			description: null,
			valid: false,
			diagnostics: ['error.repo.read'],
			error: readError,
			files,
			bytes,
		}
	}
	const described = describeFrontmatter(raw)
	const valid = described.declaredName !== null && isValidSkillName(described.declaredName)
	return {
		sourcePath: candidate.sourcePath,
		kind: candidate.kind,
		name: valid ? described.declaredName : fallbackName,
		declaredName: described.declaredName,
		description: described.description,
		valid,
		diagnostics: described.diagnostics,
		error: null,
		files,
		bytes,
	}
}

/**
 * 这条条目算不算一个技能（决定它进不进**清单**）。
 *
 * 目录候选（`<dir>/SKILL.md`）一律保留：SKILL.md 存在本身就是强信号，它坏了是上游
 * 的问题，该让人在界面上看见（状态 `invalid`）；静默藏起来只会让人以为仓库里没东西。
 *
 * 扁平候选（基目录下深度 1 的 `<name>.md`）不一样，它是**只凭「是个 .md」入选**的，
 * 所以任何仓库根都会把 README / CONTRIBUTING / CLAUDE 这类文档卷进来：它们没有 skill
 * frontmatter，装了也进不了技能目录。这不是「坏技能」，是「不是技能」，所以不进清单
 * ——否则订阅一个 monorepo 根就会刷出一屏「frontmatter 不合法」，而且一个都装不了。
 *
 * @param entry - `manifestEntryOf` 的结果。
 * @returns 该不该收进清单。
 */
export function isManifestSkill(entry) {
	return entry?.kind === 'directory' || entry?.valid === true
}

/**
 * 快照与远端清单的差异（用于「可更新」预览）。
 * @param snapshot - 安装快照（`{files: {相对路径: blobSha}}`）。
 * @param entry - 清单条目。
 * @returns `[{path, change: 'added'|'modified'|'removed'}]`。
 */
export function diffFiles(snapshot, entry) {
	const recorded = snapshot?.files ?? {}
	const remote = new Map((entry?.files ?? []).map((file) => [file.path, file.blobSha]))
	const changes = []
	for (const [path, sha] of remote) {
		const before = recorded[path]
		if (before === undefined) changes.push({ path, change: 'added' })
		else if (before !== sha) changes.push({ path, change: 'modified' })
	}
	for (const path of Object.keys(recorded)) {
		if (!remote.has(path)) changes.push({ path, change: 'removed' })
	}
	return changes.sort((a, b) => a.path.localeCompare(b.path))
}
