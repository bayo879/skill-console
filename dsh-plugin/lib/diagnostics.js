/**
 * 诊断码表（宿主侧唯一的诊断词汇表）。
 *
 * 宿主**只回码不回中文**：界面按语言环境自己翻译。这样加一种语言不用改宿主，
 * 也不会出现「宿主里塞了半句中文」的混搭。
 */

export const DIAGNOSTIC = {
	/** 文件第一行不是 `---`，没有 frontmatter 围栏。 */
	missing: 'diagnostic.frontmatter.missing',
	/** 有开头围栏但没有结束围栏。 */
	unclosed: 'diagnostic.frontmatter.unclosed',
	/** frontmatter 里有行解析不了（不是 `key: value`，也不是缩进续行）。 */
	invalid: 'diagnostic.frontmatter.invalid',
	/** 没有 `name`。 */
	nameMissing: 'diagnostic.name.missing',
	/** `name` 不符合 kebab-case 语法。 */
	nameInvalid: 'diagnostic.name.invalid',
	/** 没有 `description`（DSH 要求必须有）。 */
	descriptionMissing: 'diagnostic.description.missing',
	/** 技能是软链接，重命名会改到链接目标，因此不允许启停。 */
	symlink: 'diagnostic.symlink',
}

/** 读文件本身失败（权限、编码、断链等）。 */
export const READ_ERROR = 'error.file.read'
