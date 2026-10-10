/**
 * 订阅状态的持久化：`<stateDir>/repositories.json` + `<stateDir>/repository-cache/*.json`。
 *
 * 两条硬规则：
 *   1. **状态文件损坏时拒绝一切写入**，把错误抛出去，而不是拿一份空状态覆盖掉
 *      磁盘上那份可能只是手抖写坏但还能救的文件。用户的东西比面板重要。
 *   2. 两次写都是**原子替换**（写 `.tmp-<uuid>` 再 rename）：断电/崩溃只会留下
 *      临时文件，不会留下半截 JSON。
 *
 * 清单缓存（每次拉取的结果）坏掉则是小事：当作「还没拉取」，下次拉取会重建，
 * 所以这里只记一条日志、返回 null。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'

import { errorText, httpError } from './http.js'

/** 订阅状态文件损坏时的错误码。 */
export const STATE_ERROR = 'error.repo.state'

/**
 * 创建订阅状态存储。
 * @param options - `{stateDir, log}`。
 * @returns `{load, save, require, readManifest, writeManifest, dropManifest, cacheDir}`。
 */
export function createSubscriptionStore(options) {
	const stateDir = options.stateDir
	const log = typeof options.log === 'function' ? options.log : () => {}
	const cacheDir = join(stateDir, 'repository-cache')
	const stateFile = join(stateDir, 'repositories.json')
	let state = null

	/** 读一次状态（有缓存）。 */
	function load() {
		if (state !== null) return state
		mkdirSync(stateDir, { recursive: true })
		if (!existsSync(stateFile)) {
			state = { version: 1, repositories: [] }
			return state
		}
		let parsed
		const raw = readFileSync(stateFile, 'utf8')
		try {
			parsed = JSON.parse(raw)
		} catch (error) {
			throw httpError(500, STATE_ERROR, `订阅状态文件不是合法 JSON，已拒绝覆盖：${stateFile}（${errorText(error)}）`)
		}
		if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.repositories)) {
			throw httpError(500, STATE_ERROR, `订阅状态文件形状不认识，已拒绝覆盖：${stateFile}`)
		}
		state = { version: 1, repositories: parsed.repositories }
		return state
	}

	/** 落盘（原子替换）。 */
	function save() {
		mkdirSync(stateDir, { recursive: true })
		const payload = `${JSON.stringify({ version: 1, repositories: load().repositories }, null, 2)}\n`
		const tmp = `${stateFile}.tmp-${randomUUID()}`
		writeFileSync(tmp, payload)
		renameSync(tmp, stateFile)
	}

	/** 按 id 取一个订阅，找不到就抛 404。 */
	function requireRepo(id) {
		const found = load().repositories.find((entry) => entry.id === id)
		if (found === undefined) throw httpError(404, 'error.repo.unknown', `没有这个订阅：${id}`)
		return found
	}

	/** 清单缓存路径（用 id 的 sha1 前 16 位做文件名，避免 `owner/name` 里的斜杠）。 */
	function cachePath(id) {
		return join(cacheDir, `${createHash('sha1').update(id).digest('hex').slice(0, 16)}.json`)
	}

	/** 读缓存的清单（可能为 null：只添加过、还没拉取）。 */
	function readManifest(id) {
		const path = cachePath(id)
		if (!existsSync(path)) return null
		try {
			const parsed = JSON.parse(readFileSync(path, 'utf8'))
			return parsed && Array.isArray(parsed.skills) ? parsed : null
		} catch {
			// 缓存损坏不是错误：当作「还没拉取」，下次拉取会重建。
			log(`清单缓存损坏，已忽略：${path}`)
			return null
		}
	}

	/** 写清单缓存（原子替换）。 */
	function writeManifest(id, manifest) {
		mkdirSync(cacheDir, { recursive: true })
		const path = cachePath(id)
		const tmp = `${path}.tmp-${randomUUID()}`
		writeFileSync(tmp, JSON.stringify(manifest, null, 2))
		renameSync(tmp, path)
	}

	/** 丢弃清单缓存（订阅的分支/子目录变了，旧清单描述的是另一棵树）。 */
	function dropManifest(id) {
		rmSync(cachePath(id), { force: true })
	}

	return { load, save, require: requireRepo, readManifest, writeManifest, dropManifest, cacheDir }
}
