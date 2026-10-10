/**
 * 备份存储：`<stateDir>/backups/<skill>/<ts>/content/...`。
 *
 * 布局固定成「`content` 就是那份内容**本身**」：
 *   - 目录包 → `content/SKILL.md`、`content/references/x.md`
 *   - 扁平文件 → `content/<name>.md`
 *
 * 于是恢复只有一条路径：把 `content` 原子放回 `meta.json` 里记的 `target`，
 * 不需要为两种形态写两套还原逻辑。
 *
 * 两个必须记住的 `node:fs` 语义（都踩过）：
 *   1. `cpSync(src, dest, {recursive:true})` 在 `dest` **已存在**时是「合并进 dest」，
 *      不是复制成 `dest/<src名>`。所以目录包的 `dest` 绝不能预先 mkdir，
 *      否则会多一层，且会把已有内容覆盖掉。
 *   2. 备份目录名是毫秒时间戳，同一毫秒内会撞名。撞名 + 上面那条 = 旧备份被覆盖，
 *      这是真发生过的数据丢失；所以这里必须保证目录全新。
 */

import { randomUUID } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

import { gitBlobSha1 } from './gitsha.js'
import { errorText, httpError } from './http.js'

/**
 * 递归收集目录下的相对文件路径（跳过写入中的临时文件）。
 * @param root - 根目录。
 * @param prefix - 当前相对前缀（首层传 `''`）。
 * @param out - 结果数组（原地追加）。
 */
export function collectFiles(root, prefix, out) {
	for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
		if (entry.name.startsWith('.tmp-')) continue
		const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
		if (entry.isDirectory()) collectFiles(root, rel, out)
		else if (entry.isFile()) out.push(rel)
	}
}

/**
 * 计算一个已存在目标的当前快照（`{相对路径: git blob sha1}`）。
 * 按**原始字节**算，二进制资源同样成立。
 * @param target - 目录包目录或扁平文件。
 * @param kind - `'directory' | 'flat'`。
 * @returns 快照对象；目标不存在时为空对象。
 */
function snapshotOf(target, kind) {
	const out = {}
	if (!existsSync(target)) return out
	if (kind === 'flat' || statSync(target).isFile()) {
		out[basename(target)] = gitBlobSha1(readFileSync(target))
		return out
	}
	const files = []
	collectFiles(target, '', files)
	for (const rel of files) out[rel] = gitBlobSha1(readFileSync(join(target, rel)))
	return out
}

/**
 * 创建备份存储。
 * @param options - `{backupDir, stagingDir, now?, log?}`。
 * @returns `{create, list, find, snapshot, put}`。
 */
export function createBackupStore(options) {
	const backupDir = options.backupDir
	const stagingDir = options.stagingDir
	const now = typeof options.now === 'function' ? options.now : () => Date.now()
	const log = typeof options.log === 'function' ? options.log : () => {}

	/**
	 * 备份一个已存在的目标（目录包整份复制；扁平文件复制成单文件）。
	 * @param name - 技能名。
	 * @param target - 目标路径。
	 * @param kind - `'directory' | 'flat'`。
	 * @returns 备份目录绝对路径。
	 */
	function create(name, target, kind) {
		let at = now()
		let dir = join(backupDir, name, String(at))
		while (existsSync(dir)) {
			at += 1
			dir = join(backupDir, name, String(at))
		}
		mkdirSync(dir, { recursive: true })
		const content = join(dir, 'content')
		if (kind === 'flat' || statSync(target).isFile()) {
			mkdirSync(content, { recursive: true })
			cpSync(target, join(content, basename(target)))
		} else {
			// 刻意不预建 content：让 cpSync 把它创建成 target 的副本（而不是套一层）。
			cpSync(target, content, { recursive: true })
		}
		writeFileSync(
			join(dir, 'meta.json'),
			JSON.stringify({ name, at, kind: kind === 'flat' ? 'flat' : 'directory', target }, null, 2),
		)
		return dir
	}

	/**
	 * 列备份（`name` 省略 = 全部技能）。按时间倒序。
	 * @param name - 技能名。
	 * @returns `{backups: [{name, id, path, at, files, kind, target}]}`。
	 */
	function list(name) {
		if (!existsSync(backupDir)) return { backups: [] }
		const names = name
			? [name]
			: readdirSync(backupDir, { withFileTypes: true })
					.filter((entry) => entry.isDirectory())
					.map((entry) => entry.name)
		const out = []
		for (const skill of names) {
			const skillDir = join(backupDir, skill)
			if (!existsSync(skillDir)) continue
			for (const entry of readdirSync(skillDir, { withFileTypes: true })) {
				if (!entry.isDirectory()) continue
				const dir = join(skillDir, entry.name)
				let meta = {}
				try {
					meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'))
				} catch {
					meta = {}
				}
				const content = join(dir, 'content')
				const files = []
				if (existsSync(content)) {
					if (statSync(content).isDirectory()) collectFiles(content, '', files)
					else files.push(basename(content))
				}
				out.push({
					name: skill,
					id: entry.name,
					path: dir,
					at: Number(entry.name) || meta.at || statSync(dir).mtimeMs,
					files: files.length,
					kind: meta.kind ?? 'directory',
					target: meta.target ?? null,
				})
			}
		}
		out.sort((a, b) => b.at - a.at)
		return { backups: out }
	}

	/**
	 * 找一次备份（`backup` 省略 = 最近一次）。
	 * @returns 备份条目。
	 * @throws 404 `error.backup.notFound`。
	 */
	function find(name, backup) {
		const listed = list(name).backups
		if (listed.length === 0) throw httpError(404, 'error.backup.notFound', `没有可恢复的备份：${name}`)
		if (backup === undefined || backup === '') return listed[0]
		const entry = listed.find((item) => item.id === backup)
		if (entry === undefined) throw httpError(404, 'error.backup.notFound', `找不到这次备份：${name}/${backup}`)
		return entry
	}

	/** 当前快照（读取失败时按「已改动」处理由调用方决定，这里只透传错误）。 */
	function snapshot(target, kind) {
		try {
			return snapshotOf(target, kind)
		} catch (error) {
			log(`计算本地快照失败：${target}：${errorText(error)}`)
			throw error
		}
	}

	/** 把备份内容原子放回目标（先在 staging 里铺好，再 rename 到位）。 */
	function put(entry, target) {
		const content = join(entry.path, 'content')
		mkdirSync(stagingDir, { recursive: true })
		const staging = join(stagingDir, `restore-${randomUUID()}`)
		rmSync(staging, { recursive: true, force: true })
		if (entry.kind === 'flat') {
			mkdirSync(staging, { recursive: true })
			const file = readdirSync(content).find((item) => !item.startsWith('.'))
			if (file === undefined) throw httpError(404, 'error.backup.notFound', `备份里没有内容：${entry.path}`)
			cpSync(join(content, file), join(staging, file))
			rmSync(target, { recursive: true, force: true })
			mkdirSync(dirname(target), { recursive: true })
			renameSync(join(staging, file), target)
			rmSync(staging, { recursive: true, force: true })
			return
		}
		cpSync(content, staging, { recursive: true })
		rmSync(target, { recursive: true, force: true })
		mkdirSync(dirname(target), { recursive: true })
		renameSync(staging, target)
	}

	return { create, list, find, snapshot, put }
}
