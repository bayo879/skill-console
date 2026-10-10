/**
 * SKILL.md 的 frontmatter：围栏拆分、小子集解析、诊断。
 *
 * 刻意不引入 YAML 依赖：这里只服务于**展示与诊断**，真正决定 DSH 行为的是
 * provider 自己的解析器（`@deepseek-ai/dsh-skill` 里的 `parseFrontmatter`）。
 * 所以本模块的目标是「绝不抛、绝不猜」——看不懂的行记一条诊断，而不是编一个值。
 *
 * 围栏规则与 DSH 一致：**第一行必须正好是 `---`**（只容忍结尾 `\r`），
 * 结束围栏是另一个正好 `---` 的行。
 */

import { DIAGNOSTIC } from './diagnostics.js'

/** 技能名语法，与 `@deepseek-ai/dsh-skill` 的 `SKILL_NAME` 一致。 */
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** 技能名是否合法。 */
export function isValidSkillName(name) {
	return typeof name === 'string' && SKILL_NAME.test(name)
}

/**
 * 拆分 frontmatter 与正文。
 * @param raw - 文件全文。
 * @returns `{yaml, body, diagnostic}`；没有/不完整的围栏时 `yaml` 为 null。
 */
export function splitFrontmatter(raw) {
	const firstBreak = raw.indexOf('\n')
	if (firstBreak < 0) return { yaml: null, body: raw, diagnostic: DIAGNOSTIC.missing }
	if (raw.slice(0, firstBreak).replace(/\r$/, '') !== '---') {
		return { yaml: null, body: raw, diagnostic: DIAGNOSTIC.missing }
	}
	const start = firstBreak + 1
	let cursor = start
	while (cursor <= raw.length) {
		const lineBreak = raw.indexOf('\n', cursor)
		const end = lineBreak < 0 ? raw.length : lineBreak
		const line = raw.slice(cursor, end).replace(/\r$/, '')
		if (line === '---') {
			return { yaml: raw.slice(start, cursor), body: raw.slice(lineBreak < 0 ? raw.length : lineBreak + 1), diagnostic: null }
		}
		if (lineBreak < 0) break
		cursor = lineBreak + 1
	}
	return { yaml: null, body: raw, diagnostic: DIAGNOSTIC.unclosed }
}

/** 去掉成对引号。 */
function unquote(value) {
	const text = value.trim()
	if (text.length >= 2 && ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")))) {
		return text.slice(1, -1)
	}
	return text
}

/**
 * 解析我们关心的标量字段（顶层 `key: scalar`、成对引号、`|`/`>` 块标量）。
 *
 * 嵌套 mapping / 序列只做「跳过」，不参与取值——技能的 `name` / `description`
 * 必须是顶层标量，嵌套里的同名键不该被误读。
 *
 * @param yaml - 围栏内的原始文本。
 * @returns `{fields, invalid}`；`invalid` = 有行既不是键值对也不是缩进续行。
 */
export function parseFrontmatterFields(yaml) {
	const fields = {}
	const lines = yaml.split('\n')
	let invalid = false
	let blockKey = null
	let blockLines = []
	const flush = () => {
		if (blockKey === null) return
		fields[blockKey] = blockLines.join('\n').trim()
		blockKey = null
		blockLines = []
	}
	for (const rawLine of lines) {
		const line = rawLine.replace(/\r$/, '')
		if (/^[ \t]/.test(line)) {
			if (blockKey !== null) blockLines.push(line.trim())
			continue
		}
		flush()
		const trimmed = line.trim()
		if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith('- ')) continue
		const colon = trimmed.indexOf(':')
		if (colon <= 0) {
			invalid = true
			continue
		}
		const key = trimmed.slice(0, colon).trim()
		const value = trimmed.slice(colon + 1).trim()
		if (value === '' || value === '|' || value === '>' || value === '|-' || value === '>-' || value === '|+' || value === '>+') {
			// 可能是块标量，也可能是嵌套结构；由后续缩进行决定。
			blockKey = key
			blockLines = []
			continue
		}
		fields[key] = unquote(value)
	}
	flush()
	return { fields, invalid }
}

/**
 * 从文件全文里抽出我们关心的事实。
 *
 * 扫描、单读、仓库清单三处**共用这一个函数**——各写一份的话，面板上的诊断
 * 迟早会和实际加载行为漂移。
 *
 * @param raw - 文件全文。
 * @returns `{declaredName, description, diagnostics, body}`。
 */
export function describeFrontmatter(raw) {
	const split = splitFrontmatter(raw)
	const { fields, invalid } = split.yaml === null ? { fields: {}, invalid: false } : parseFrontmatterFields(split.yaml)
	const diagnostics = []
	if (split.diagnostic !== null) diagnostics.push(split.diagnostic)
	if (invalid) diagnostics.push(DIAGNOSTIC.invalid)
	const declaredName = typeof fields.name === 'string' ? fields.name : null
	if (declaredName === null) diagnostics.push(DIAGNOSTIC.nameMissing)
	else if (!SKILL_NAME.test(declaredName)) diagnostics.push(DIAGNOSTIC.nameInvalid)
	const description = typeof fields.description === 'string' && fields.description !== '' ? fields.description : null
	if (description === null) diagnostics.push(DIAGNOSTIC.descriptionMissing)
	return { declaredName, description, diagnostics, body: split.body }
}
