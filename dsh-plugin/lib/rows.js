/**
 * 把「订阅记录 + 远端清单 + 本地磁盘」算成界面要的**技能行**。
 *
 * 这一层是纯计算（只读磁盘判断存在性/改动，不写任何东西），所以能从管理器里
 * 拆出来：状态机（status）必须只有一份实现，否则列表页和详情页迟早讲两套话。
 *
 * 状态机的语义（`status`）：
 *   - `invalid`          远端 SKILL.md 的 frontmatter 不合法（装不了，去上游修）
 *   - `not-installed`    清单里有、本地没装
 *   - `installed`        装过，且安装时的 commit == 清单 commit
 *   - `update-available` 装过，但清单 commit 变了
 *   - `upstream-deleted` 本地装过、这次清单里没了（**不会自动删**，只是告诉你）
 *
 * `conflict`（本地已有同名技能但不属于本订阅）与 `localModified`（本地内容与安装
 * 快照不一致）是两个正交的标记，它们只影响 `requiresConfirm`，不影响 status。
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { isValidSkillName } from './frontmatter.js'
import { diffFiles } from './repo-manifest.js'

/** 安装目标路径：目录包 → `<skillsDir>/<name>/`；扁平 → `<skillsDir>/<name>.md`。 */
export function targetPathFor(skillsDir, name, kind) {
	return kind === 'flat' ? join(skillsDir, `${name}.md`) : join(skillsDir, name)
}

/**
 * 一个订阅的全部技能行（含「上游已删除」这种本地才存在的情况）。
 * @param context - `{skillsDir, isLocallyModified}`。
 * @param record - 订阅记录。
 * @param manifest - 清单（可为 null）。
 * @returns 技能行数组（按名字排序）。
 */
export function describeSkills(context, record, manifest) {
	const skillsDir = context.skillsDir
	const rows = []
	const seen = new Set()
	for (const entry of manifest?.skills ?? []) {
		const name = entry.name
		const snapshot = name && record.skills ? record.skills[name] : undefined
		const target = name ? targetPathFor(skillsDir, name, entry.kind) : null
		const exists = target !== null && existsSync(target)
		const conflict = snapshot === undefined && exists
		const localModified = snapshot !== undefined ? context.isLocallyModified(target, snapshot) : false
		let status
		if (!entry.valid || !isValidSkillName(name)) status = 'invalid'
		else if (snapshot === undefined) status = 'not-installed'
		else if (snapshot.commit !== manifest.commit) status = 'update-available'
		else status = 'installed'
		rows.push({
			sourcePath: entry.sourcePath,
			kind: entry.kind,
			name,
			declaredName: entry.declaredName,
			description: entry.description,
			valid: entry.valid,
			diagnostics: entry.diagnostics,
			error: entry.error ?? null,
			status,
			installedPath: snapshot !== undefined || conflict ? target : null,
			installedCommit: snapshot?.commit ?? null,
			latestCommit: manifest?.commit ?? null,
			localModified,
			conflict,
			changedFiles: status === 'update-available' ? diffFiles(snapshot, entry) : [],
			files: (entry.files ?? []).length,
			bytes: entry.bytes ?? 0,
			requiresConfirm: conflict || (status === 'update-available' && localModified),
		})
		if (name) seen.add(name)
	}
	for (const [name, snapshot] of Object.entries(record.skills ?? {})) {
		if (seen.has(name)) continue
		const target = targetPathFor(skillsDir, name, snapshot.kind ?? 'directory')
		rows.push({
			sourcePath: snapshot.sourcePath,
			kind: snapshot.kind ?? 'directory',
			name,
			declaredName: name,
			description: null,
			valid: true,
			diagnostics: [],
			error: null,
			status: 'upstream-deleted',
			installedPath: target,
			installedCommit: snapshot.commit ?? null,
			latestCommit: manifest?.commit ?? null,
			localModified: context.isLocallyModified(target, snapshot),
			conflict: false,
			changedFiles: [],
			files: Object.keys(snapshot.files ?? {}).length,
			bytes: 0,
			requiresConfirm: false,
		})
	}
	return rows.sort((a, b) => String(a.name).localeCompare(String(b.name)))
}

/** 汇总计数（订阅列表用）。 */
export function summarize(rows) {
	const status = {
		total: rows.length,
		notInstalled: 0,
		installed: 0,
		updateAvailable: 0,
		upstreamDeleted: 0,
		invalid: 0,
		localModified: 0,
		conflict: 0,
	}
	for (const row of rows) {
		if (row.status === 'not-installed') status.notInstalled += 1
		else if (row.status === 'installed') status.installed += 1
		else if (row.status === 'update-available') status.updateAvailable += 1
		else if (row.status === 'upstream-deleted') status.upstreamDeleted += 1
		else if (row.status === 'invalid') status.invalid += 1
		if (row.localModified) status.localModified += 1
		if (row.conflict) status.conflict += 1
	}
	return status
}
