/**
 * 技能仓库订阅：把 GitHub 上的技能仓库变成「可手动拉取、可挑选安装、可回滚」的订阅。
 *
 * 本文件只做**编排**，重活都在邻居模块里：
 *   - `github.js`  —— 地址解析、API、下载、commit/tree 解析
 *   - `store.js`   —— 订阅状态文件 + 清单缓存的持久化
 *   - `rows.js`    —— 状态机（技能行）+ 汇总
 *   - `backups.js` —— 备份存储、快照、原子恢复
 *   - `frontmatter.js` —— 远端 SKILL.md 的 name/description 解析（与本地扫描同一份口径）
 *
 * 几条刻意的设计边界：
 *
 *   1. **安装可以指定目标**：缺省写全局 DSH 技能根（`<DSH_HOME>/skills`），
 *      显式传 `targetSkillsDir` 时写那个目录（当前项目技能根走这条路）。
 *      没有 `targetSkillsDir` 时行为与 0.3.0 完全一致。
 *   2. **拉取（fetch）不等于安装**。拉取只更新清单缓存，绝不碰技能目录；
 *      安装是另一个显式动作，且覆盖前一定先备份。
 *   3. **不覆盖别人的东西**：目标位置已有同名技能但不属于本订阅（冲突），
 *      或本地内容与安装快照不一致（被改过），都必须 `confirm: true` 才动手。
 *   4. **只有真技能才进清单**：扁平候选（基目录下的 `<name>.md`）必须有合法
 *      frontmatter 才收入清单，否则仓库根下的 README/CONTRIBUTING 会被当成
 *      「frontmatter 不合法的技能」刷屏（判据在 `repo-manifest.js` 的
 *      `isManifestSkill`）。目录候选不受影响：SKILL.md 坏了要让人看见。
 *   5. **可用仓库是第三个落点，不是技能根**：`sync` 把清单里的技能同步到
 *      `libraryDir`（`<DSH_HOME>/skill-console/library`）。DSH 不加载这个目录，
 *      所以同步完不需要让技能注册表失效；它只有一个用途——给「角色」当候选池
 *      （角色切换是往项目技能根复制，与这里无关）。`install` 写技能根、`sync`
 *      写库，两条路径共用同一份落盘实现（判据/备份/确认只能有一处）。
 *
 * 没有轮询、没有自动更新：拉取只发生在「添加订阅」和用户点「拉取最新」时。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { basename, dirname, join } from 'node:path'

import { collectFiles, createBackupStore } from './backups.js'
import { describeFrontmatter, isValidSkillName } from './frontmatter.js'
import { createGitHubClient, MAX_FILE_BYTES, parseRepositoryInput, readToken } from './github.js'
import { gitBlobSha1 } from './gitsha.js'
import { errorText, httpError } from './http.js'
import { assertSafeRelative, collectCandidates, filesOf, isManifestSkill, manifestEntryOf, MAX_SKILLS_PER_REPO, skillMdPathOf } from './repo-manifest.js'
import { describeSkills, summarize, targetPathFor } from './rows.js'
import { createSubscriptionStore } from './store.js'

// 这几个的实现在邻居模块里，但从这里一并对外暴露：调用方（index.js / 契约测试）
// 只需要认「仓库订阅」这一层。
export { MAX_FILE_BYTES, parseRepositoryInput, readToken } from './github.js'
export { gitBlobSha1, gitBlobSha1OfText } from './gitsha.js'
export { collectCandidates, diffFiles, filesOf, manifestEntryOf, skillMdPathOf } from './repo-manifest.js'

/** 单个技能所有文件合计上限。 */
export const MAX_SKILL_BYTES = 32 * 1024 * 1024
/** 订阅数量上限。 */
export const MAX_REPOSITORIES = 100

/** 清理用户填的子目录（拒绝绝对路径与 `..`）。 */
export function normalizeSubdirectory(value) {
	const text = typeof value === 'string' ? value.trim().replace(/^\/+|\/+$/g, '') : ''
	if (text === '') return ''
	if (text.split('/').some((part) => part === '..' || part === '')) {
		throw httpError(400, 'error.repo.subdirectory', `子目录不合法：${value}`)
	}
	return text
}

/**
 * 创建一个仓库管理器。
 *
 * @param options - `{stateDir, skillsDir, libraryDir, log, fetchImpl?, token?, now?}`。
 *   `stateDir` = `<DSH_HOME>/skill-console`；`skillsDir` = `<DSH_HOME>/skills`；
 *   `libraryDir` = `<DSH_HOME>/skill-console/library`（「可用仓库」落点，缺省按这个算）。
 *   `fetchImpl` 可注入（离线契约测试用桩替换网络）。
 * @returns 管理器。
 */
export function createRepositoryManager(options) {
	const stateDir = options.stateDir
	const skillsDir = options.skillsDir
	// 可用仓库缺省与 stateDir 同级：它属于 skill-console 自己的数据，
	// 不是 DSH 的技能根，所以不能挂在 skillsDir 底下。
	const libraryDir = typeof options.libraryDir === 'string' && options.libraryDir !== '' ? options.libraryDir : join(stateDir, 'library')
	const stagingDir = join(stateDir, 'staging')
	const now = options.now ?? (() => Date.now())
	const log = options.log ?? (() => {})
	const tokenOf = () => (typeof options.token === 'function' ? options.token() : readToken())
	const github = createGitHubClient({ fetchImpl: options.fetchImpl, tokenOf, log })
	const store = createSubscriptionStore({ stateDir, log })
	const backups = createBackupStore({ backupDir: join(stateDir, 'backups'), stagingDir, now, log })

	/** 让技能注册表失效的外壳由 index.js 注入；这里只负责在写盘后喊一声。 */
	let afterMutation = () => {}

	/** 一次拉取最多处理的技能条目数（防止把超大仓库当索引拖垮界面）。 */
	const maxSkillsPerRepo = options.maxSkillsPerRepo ?? MAX_SKILLS_PER_REPO

	/**
	 * 拉取：解析 ref → commit → tree，下载每个候选的 SKILL.md 读 frontmatter，
	 * 写清单缓存。**不写任何技能目录**。
	 *
	 * 候选里「不是技能」的那些（根级 README / CONTRIBUTING 之类）在这里被丢掉，
	 * 不进清单也不计数——判据见 `isManifestSkill`。
	 *
	 * @param id - `owner/name`。
	 * @returns `{record, manifest}`。
	 */
	async function fetchRepository(id) {
		const record = store.require(id)
		const ref = record.ref !== '' ? record.ref : await github.defaultBranch(record.owner, record.name)
		const commit = await github.resolveCommit(record.owner, record.name, ref)
		const tree = await github.tree(record.owner, record.name, commit.sha)

		const candidates = collectCandidates(tree, record.subdirectory, maxSkillsPerRepo)
		const skills = []
		for (const candidate of candidates) {
			let raw = null
			let readError = null
			try {
				const buffer = await github.download(github.rawUrl(record.owner, record.name, commit.sha, skillMdPathOf(candidate)), MAX_FILE_BYTES)
				raw = buffer.toString('utf8')
			} catch (error) {
				readError = errorText(error)
			}
			const entry = manifestEntryOf(candidate, raw, filesOf(tree, candidate), readError)
			// 不是技能的根级 .md 不进清单（判据与理由见 `isManifestSkill`）。
			if (isManifestSkill(entry)) skills.push(entry)
		}

		store.writeManifest(record.id, { id: record.id, commit: commit.sha, fetchedAt: now(), skills })
		record.lastFetch = {
			at: now(),
			commit: commit.sha,
			commitShort: commit.sha.slice(0, 7),
			commitMessage: commit.message,
			commitDate: commit.date,
			skillCount: skills.length,
			error: null,
		}
		store.save()
		log(`${record.id}: 拉取到 ${skills.length} 个技能 @ ${commit.sha.slice(0, 7)}`)
		return { record, manifest: store.readManifest(record.id) }
	}

	/** 本地文件是否与安装快照一致（一致 = 没被人改过）。 */
	function isLocallyModified(target, snapshot) {
		try {
			return locallyModifiedUnsafe(target, snapshot)
		} catch (error) {
			// 读不动就当「改过」——宁可多要一次确认，也不静默覆盖别人的文件。
			log(`检查本地改动失败（按已改动处理）：${target}：${errorText(error)}`)
			return true
		}
	}

	/** 用 git blob SHA-1 比对**原始字节**（二进制资源同样成立，不是只对文本）。 */
	function locallyModifiedUnsafe(target, snapshot) {
		if (!existsSync(target)) return true
		const recorded = snapshot?.files ?? {}
		const stat = statSync(target)
		if (stat.isFile()) {
			const rel = Object.keys(recorded)[0]
			if (rel === undefined) return true
			return gitBlobSha1(readFileSync(target)) !== recorded[rel]
		}
		const onDisk = []
		collectFiles(target, '', onDisk)
		if (onDisk.length !== Object.keys(recorded).length) return true
		for (const rel of onDisk) {
			if (recorded[rel] === undefined) return true
			if (gitBlobSha1(readFileSync(join(target, rel))) !== recorded[rel]) return true
		}
		return false
	}

	/** 技能行计算（状态机在 rows.js 里，这里只把上下文递进去）。 */
	function rowsOf(record, manifest) {
		return describeSkills({ skillsDir, isLocallyModified }, record, manifest)
	}

	/** 下载一个技能的全部文件并逐字节校验。 */
	async function downloadSkillFiles(record, commit, entry) {
		const files = []
		let total = 0
		for (const file of entry.files ?? []) {
			const repoPath = entry.kind === 'directory' ? `${entry.sourcePath}/${file.path}` : entry.sourcePath
			const buffer = await github.download(github.rawUrl(record.owner, record.name, commit, repoPath), MAX_FILE_BYTES)
			const sha = gitBlobSha1(buffer)
			if (typeof file.blobSha === 'string' && file.blobSha !== '' && sha !== file.blobSha) {
				throw httpError(502, 'error.install.verify', `下载内容与仓库快照不一致，已放弃：${repoPath}`)
			}
			total += buffer.length
			if (total > MAX_SKILL_BYTES) throw httpError(502, 'error.install.tooLarge', `技能内容超过上限（${MAX_SKILL_BYTES} 字节）：${entry.sourcePath}`)
			files.push({ rel: entry.kind === 'directory' ? assertSafeRelative(file.path) : basename(entry.sourcePath), buffer, blobSha: sha })
		}
		if (files.length === 0) throw httpError(502, 'error.install.empty', `仓库里这个技能没有任何文件：${entry.sourcePath}`)
		return files
	}

	/**
	 * 原子落地：先在 `staging/` 里把整棵树搭好，再 rename 到位。
	 * 中途失败时目标位置要么还是旧版本、要么是新版本，不会是半截。
	 */
	function writeSkill(target, kind, files) {
		mkdirSync(stagingDir, { recursive: true })
		const staging = join(stagingDir, `stage-${randomUUID()}`)
		rmSync(staging, { recursive: true, force: true })
		mkdirSync(staging, { recursive: true })
		for (const file of files) {
			const dest = join(staging, file.rel)
			mkdirSync(dirname(dest), { recursive: true })
			writeFileSync(dest, file.buffer)
		}
		rmSync(target, { recursive: true, force: true })
		mkdirSync(dirname(target), { recursive: true })
		if (kind === 'flat') {
			// 扁平技能是一个文件：把 staging 里那一个文件 rename 到目标。
			renameSync(join(staging, files[0].rel), target)
			rmSync(staging, { recursive: true, force: true })
			return
		}
		renameSync(staging, target)
	}

	/**
	 * 把一个清单条目落到 `dir` 下：判据 → 下载 → 备份 → 原子写。
	 *
	 * `install`（写技能根）与 `sync`（写可用仓库）共用这一份实现：「覆盖前先备份」
	 * 「本地改动要确认」「跳过原因文案」只能有一处，否则两条路径迟早讲两套话。
	 *
	 * **不写任何台账**：写 `record.skills` 还是 `record.library` 由调用方决定——
	 * 两者语义不同，一处是「装进了技能根」，一处是「同步进了库」。
	 *
	 * @param input - `{record, manifest, entry, dir, snapshot, confirm}`。
	 *   `snapshot` 是**对应这份台账**里该技能的快照；`undefined` 表示这个目标不受
	 *   任何台账作证，于是只存在同名就一律当冲突，必须 `confirm: true`。
	 * @returns `{ok: true, name, path, updated, backup, files}` 或 `{ok: false, name, reason}`。
	 */
	async function writeManifestEntry({ record, manifest, entry, dir, snapshot, confirm }) {
		const name = entry.name
		if (!entry.valid || !isValidSkillName(name)) {
			return { ok: false, name, reason: 'skill frontmatter is invalid; fix it upstream' }
		}
		const target = targetPathFor(dir, name, entry.kind)
		const conflict = existsSync(target) && snapshot === undefined
		// 「文件不在了」不算本地改动：没什么可保护的，直接补回来。
		const modified = snapshot !== undefined && existsSync(target) && isLocallyModified(target, snapshot)
		if ((conflict || modified) && confirm !== true) {
			return {
				ok: false,
				name,
				reason: conflict
					? 'a local skill with this name exists and is not tracked by this subscription; pass confirm:true to overwrite (a backup is taken)'
					: 'local modifications detected; pass confirm:true to overwrite (a backup is taken)',
			}
		}
		const files = await downloadSkillFiles(record, manifest.commit, entry)
		const backup = existsSync(target) ? backups.create(name, target, entry.kind) : null
		writeSkill(target, entry.kind, files)
		return {
			ok: true,
			name,
			path: target,
			updated: snapshot !== undefined || conflict,
			backup,
			files: Object.fromEntries(files.map((file) => [file.rel, file.blobSha])),
		}
	}

	/**
	 * 把这份清单里能用的技能同步进可用仓库（`libraryDir`）。
	 *
	 * 这就是「订阅」的默认落点：`add` / `update` / `fetchAndSync` 拉完清单都会调它，
	 * 面板上没有单独的「同步」按钮。DSH 不加载库，所以这里**不调 `afterWrite`**
	 * （让技能注册表失效没有意义）。
	 *
	 * 幂等：台账 commit 与清单一致、本地又没被动过 → 记 `unchanged`，连下载都省掉。
	 * 台账（`record.library`）循环结束后一次落盘：逐个技能 save 会在几十个技能时
	 * 写几十遍状态文件。
	 *
	 * @param id - 订阅 id。
	 * @param confirm - `true` 时才允许覆盖「来源不明」或「被本地改过」的目标（覆盖前一律备份）。
	 * @returns `{synced, unchanged, skipped}`。
	 */
	async function syncToLibrary(id, confirm) {
		const record = store.require(id)
		const manifest = store.readManifest(id) ?? (await fetchRepository(id)).manifest
		const synced = []
		const unchanged = []
		const skipped = []
		let dirty = false
		for (const entry of manifest.skills ?? []) {
			const name = entry.name
			try {
				const snapshot = record.library?.[name]
				if (!entry.valid || !isValidSkillName(name)) {
					skipped.push({ name, reason: 'skill frontmatter is invalid; fix it upstream' })
					continue
				}
				const target = targetPathFor(libraryDir, name, entry.kind)
				// 幂等短路：清单 commit 与台账一致、本地又没被动过 → 什么都不用做。
				if (snapshot !== undefined && snapshot.commit === manifest.commit && !isLocallyModified(target, snapshot)) {
					unchanged.push(name)
					continue
				}
				const outcome = await writeManifestEntry({ record, manifest, entry, dir: libraryDir, snapshot, confirm })
				if (outcome.ok !== true) {
					skipped.push({ name: outcome.name ?? name, reason: outcome.reason })
					continue
				}
				record.library = record.library ?? {}
				record.library[name] = {
					sourcePath: entry.sourcePath,
					kind: entry.kind,
					commit: manifest.commit,
					syncedAt: now(),
					files: outcome.files,
				}
				dirty = true
				synced.push({ name, path: outcome.path, updated: outcome.updated, backup: outcome.backup })
			} catch (error) {
				skipped.push({ name, reason: errorText(error) })
			}
		}
		if (dirty) store.save()
		return { synced, unchanged, skipped }
	}

	/**
	 * 拉取清单 + 顺手同步进库：订阅的默认行为（添加、编辑分支、点「拉取最新」都走这里）。
	 *
	 * 同步失败不推翻拉取结果：清单已经更新，把 `syncError` 报出来让用户再拉一次即可。
	 */
	async function fetchAndSync(id) {
		const { record, manifest } = await fetchRepository(id)
		let sync = null
		let syncError = null
		try {
			sync = await syncToLibrary(id, false)
		} catch (error) {
			syncError = errorText(error)
		}
		return { record, manifest, sync, syncError }
	}

	/**
	 * 库台账对这份清单的覆盖情况。**只比 commit、不读盘**：列表接口每个订阅都要算，
	 * 逐文件比对会把「打开仓库页」变成一次全盘扫描；本地改动要到 `sync` 才暴露。
	 *
	 * `count` 可能大于 `synced + outdated`：台账里有、清单里已经没有的技能（上游删了）
	 * 仍留在库里，只是不再被这份清单覆盖。报表以 `synced` / `outdated` 为准。
	 */
	function librarySummaryOf(record, manifest) {
		const snapshots = record.library ?? {}
		const entries = manifest?.skills ?? []
		let synced = 0
		let outdated = 0
		for (const entry of entries) {
			const snapshot = snapshots[entry.name]
			if (snapshot === undefined) continue
			if (snapshot.commit !== manifest.commit) outdated += 1
			else synced += 1
		}
		const orphan = Object.keys(snapshots).filter((name) => !entries.some((entry) => entry.name === name)).length
		return { count: Object.keys(snapshots).length, synced, outdated, orphan }
	}

	/**
	 * 单个清单条目在可用仓库里的状态（详情行用）。与 `librarySummaryOf` 的区别：
	 * 这里会读盘比一次内容，所以只在打开一个订阅的详情时算。
	 */
	function libraryStateOf(record, manifest, entry) {
		const snapshot = record.library?.[entry.name]
		if (snapshot === undefined) return { state: 'missing', commit: null, syncedAt: null }
		const base = { state: 'synced', commit: snapshot.commit ?? null, syncedAt: snapshot.syncedAt ?? null }
		const target = targetPathFor(libraryDir, entry.name, entry.kind)
		if (!existsSync(target)) return { ...base, state: 'missing' }
		if (isLocallyModified(target, snapshot)) return { ...base, state: 'modified' }
		if (snapshot.commit !== manifest.commit) return { ...base, state: 'outdated' }
		return base
	}

	/** 给详情行补上「这份清单条目在库里是什么状态」。 */
	function libraryRowsOf(record, manifest, rows) {
		const entries = manifest?.skills ?? []
		return rows.map((row) => {
			const entry = entries.find((candidate) => candidate.name === row.name)
			if (entry === undefined) {
				// 台账里有、清单里没有（上游删了）：保留在库里，这里如实标成孤儿。
				return { ...row, library: { state: 'orphan', commit: record.library?.[row.name]?.commit ?? null, syncedAt: record.library?.[row.name]?.syncedAt ?? null } }
			}
			return { ...row, library: libraryStateOf(record, manifest, entry) }
		})
	}

	/** 单个订阅的详情（技能行，每行带可用仓库状态）。 */
	function detailOf(id) {
		const record = store.require(id)
		const manifest = store.readManifest(id)
		return {
			repository: {
				id: record.id,
				owner: record.owner,
				name: record.name,
				url: `https://github.com/${record.owner}/${record.name}`,
				ref: record.ref,
				subdirectory: record.subdirectory,
				addedAt: record.addedAt,
				lastFetch: record.lastFetch ?? null,
			},
			skills: libraryRowsOf(record, manifest, rowsOf(record, manifest)),
			fetched: manifest !== null,
		}
	}

	/** 调一次 mutation 钩子（钩子抛错不该影响已经落盘的结果）。 */
	function afterWrite(what) {
		try {
			afterMutation()
		} catch (error) {
			log(`${what}后让技能注册表失效失败：${errorText(error)}`)
		}
	}

	return {
		/** 写盘成功后调一次（让技能注册表失效）。 */
		setAfterMutation(fn) {
			afterMutation = typeof fn === 'function' ? fn : () => {}
		},

		/** 订阅列表 + 汇总状态（含「可用仓库」的覆盖情况）。 */
		list() {
			const repositories = store.load().repositories.map((record) => {
				const manifest = store.readManifest(record.id)
				return {
					id: record.id,
					owner: record.owner,
					name: record.name,
					url: `https://github.com/${record.owner}/${record.name}`,
					ref: record.ref,
					subdirectory: record.subdirectory,
					addedAt: record.addedAt,
					lastFetch: record.lastFetch ?? null,
					installedCount: Object.keys(record.skills ?? {}).length,
					status: summarize(rowsOf(record, manifest)),
					library: librarySummaryOf(record, manifest),
				}
			})
			return { repositories, token: tokenOf() !== null, maxRepositories: MAX_REPOSITORIES }
		},

		detail: detailOf,

		/**
		 * 添加订阅并立刻做一次初始发现。
		 *
		 * 拉取失败时订阅**仍然保留**（用户可以在网络恢复后点「拉取最新」），
		 * 并把失败原因记在 `lastFetch.error` 里——静默吞掉失败才是真的糟糕。
		 */
		async add({ url, ref, subdirectory }) {
			const parsed = parseRepositoryInput(url)
			if (parsed === null) throw httpError(400, 'error.repo.url', `解析不出 owner/name：${String(url)}`)
			const id = `${parsed.owner}/${parsed.name}`
			const current = store.load()
			if (current.repositories.some((entry) => entry.id === id)) {
				throw httpError(409, 'error.repo.exists', `已经订阅过：${id}`)
			}
			if (current.repositories.length >= MAX_REPOSITORIES) {
				throw httpError(400, 'error.repo.limit', `订阅数量已达上限（${MAX_REPOSITORIES}）`)
			}
			const record = {
				id,
				owner: parsed.owner,
				name: parsed.name,
				ref: typeof ref === 'string' && ref.trim() !== '' ? ref.trim() : parsed.ref,
				subdirectory: normalizeSubdirectory(typeof subdirectory === 'string' && subdirectory.trim() !== '' ? subdirectory : parsed.subdirectory),
				addedAt: now(),
				lastFetch: null,
				skills: {},
			}
			current.repositories.push(record)
			store.save()
			try {
				// 订阅默认就同步：拉完清单立刻把能用的技能落进可用仓库（也就是角色候选池）。
				const { record: fetchedRecord, manifest, sync, syncError } = await fetchAndSync(id)
				return { repository: detailOf(id).repository, skills: rowsOf(fetchedRecord, manifest), fetchError: null, sync, syncError }
			} catch (error) {
				record.lastFetch = { at: now(), commit: null, commitShort: null, commitMessage: null, commitDate: null, skillCount: 0, error: errorText(error) }
				store.save()
				return { repository: detailOf(id).repository, skills: [], fetchError: errorText(error), sync: null, syncError: null }
			}
		},

		/**
		 * 编辑已有订阅：只改**分支/标签**与**子目录**。
		 *
		 * 地址不在这里改——`owner/name` 是订阅的身份，换了就是另一个仓库，必须走
		 * 「移除订阅 + 添加」两步（已安装的技能文件也因此不会被莫名其妙地对到别的仓库）。
		 *
		 * 改动真的生效时才动缓存：分支/子目录一变，旧清单描述的是另一棵目录树，
		 * 必须丢弃并立刻重拉，否则「安装」会照着过期清单装错东西。
		 */
		async update({ id, ref, subdirectory }) {
			const record = store.require(id)
			const nextRef = typeof ref === 'string' ? ref.trim() : record.ref
			const nextSubdirectory = normalizeSubdirectory(typeof subdirectory === 'string' ? subdirectory : record.subdirectory)
			if (nextRef === record.ref && nextSubdirectory === record.subdirectory) {
				return { changed: false, repository: detailOf(id).repository, skills: rowsOf(record, store.readManifest(id)), fetchError: null, sync: null, syncError: null }
			}
			record.ref = nextRef
			record.subdirectory = nextSubdirectory
			store.dropManifest(id)
			record.lastFetch = null
			store.save()
			try {
				const { record: fetchedRecord, manifest, sync, syncError } = await fetchAndSync(id)
				return { changed: true, repository: detailOf(id).repository, skills: rowsOf(fetchedRecord, manifest), fetchError: null, sync, syncError }
			} catch (error) {
				record.lastFetch = { at: now(), commit: null, commitShort: null, commitMessage: null, commitDate: null, skillCount: 0, error: errorText(error) }
				store.save()
				return { changed: true, repository: detailOf(id).repository, skills: [], fetchError: errorText(error), sync: null, syncError: null }
			}
		},

		/** 只删订阅记录：技能文件原样留着（卸载订阅 ≠ 删技能）。 */
		remove(id) {
			const current = store.load()
			const index = current.repositories.findIndex((entry) => entry.id === id)
			if (index < 0) throw httpError(404, 'error.repo.unknown', `没有这个订阅：${id}`)
			const [removed] = current.repositories.splice(index, 1)
			store.save()
			return { removed: removed.id, installedKept: Object.keys(removed.skills ?? {}) }
		},

		fetch: fetchRepository,

		/** 拉取清单并顺手同步进库（「拉取最新」「添加订阅」「改分支」都走它）。 */
		fetchAndSync,

		/**
		 * 重来一次同步。订阅本身已经在同步，这个入口只有一个用途：
		 * 用户看清「哪些被本地改过」之后，带 `confirm: true` 确认覆盖（覆盖前一律备份）。
		 */
		sync({ id, confirm }) {
			return syncToLibrary(id, confirm)
		},

		/** 手动安装/更新选中的技能（落到技能根：缺省的全局根，或显式传入的项目根）。 */
		async install({ id, skills, confirm, targetSkillsDir }) {
			const record = store.require(id)
			const manifest = store.readManifest(id) ?? (await fetchRepository(id)).manifest
			const wanted = Array.isArray(skills) ? skills : []
			// 目标目录：缺省 = 这个 manager 的全局 skillsDir（向后兼容）
			const dir = typeof targetSkillsDir === 'string' && targetSkillsDir !== '' ? targetSkillsDir : skillsDir
			const installed = []
			const skipped = []
			for (const name of wanted) {
				try {
					const entry = (manifest.skills ?? []).find((candidate) => candidate.name === name)
					if (entry === undefined) {
						skipped.push({ name, reason: 'not in the fetched manifest; run 拉取最新 first' })
						continue
					}
					// 订阅快照只描述全局那份：装到别的根时它不能证明目标没被改过。
					const snapshot = dir === skillsDir ? record.skills?.[name] : undefined
					const outcome = await writeManifestEntry({ record, manifest, entry, dir, snapshot, confirm })
					if (outcome.ok !== true) {
						skipped.push({ name: outcome.name ?? name, reason: outcome.reason })
						continue
					}
					// 只在写全局时才更新订阅快照：项目安装不写台账，免得顶掉全局那份的记录。
					if (dir === skillsDir) {
						record.skills = record.skills ?? {}
						record.skills[name] = {
							sourcePath: entry.sourcePath,
							kind: entry.kind,
							commit: manifest.commit,
							installedAt: now(),
							files: outcome.files,
						}
						store.save()
					}
					installed.push({ name, path: outcome.path, updated: outcome.updated, backup: outcome.backup })
				} catch (error) {
					skipped.push({ name, reason: errorText(error) })
				}
			}
			if (installed.length > 0) afterWrite('安装')
			return { installed, skipped }
		},

		/** 备份列表（`name` 省略 = 全部技能）。 */
		backups(name) {
			return backups.list(name)
		},

		/** 删除/移动前调用的一次性整份备份（透传 `backups.create`，路径知识只留在这一层）。 */
		backupSkill({ name, target, kind }) {
			return backups.create(name, target, kind)
		},

		/** 恢复某次备份（省略 id = 最近一次）。恢复前会把当前版本再备份一次。 */
		restore({ name, backup }) {
			const entry = backups.find(name, backup)
			const target = entry.target ?? targetPathFor(skillsDir, name, entry.kind)
			if (existsSync(target)) backups.create(name, target, entry.kind)
			backups.put(entry, target)
			// 恢复后本地内容变了，快照必须跟着走，否则会被误判成「本地被改过」。
			for (const record of store.load().repositories) {
				const snapshot = record.skills?.[name]
				if (snapshot === undefined) continue
				snapshot.files = backups.snapshot(target, entry.kind)
				snapshot.installedAt = now()
			}
			store.save()
			afterWrite('恢复')
			return { name, backup: entry.id, path: target, restored: true }
		},

		/** 技能名 → 订阅来源（技能 tab 上显示徽标用）。 */
		installedIndex() {
			const index = new Map()
			for (const record of store.load().repositories) {
				for (const [name, snapshot] of Object.entries(record.skills ?? {})) {
					index.set(name, {
						id: record.id,
						owner: record.owner,
						name: record.name,
						commit: snapshot.commit ?? null,
						sourcePath: snapshot.sourcePath ?? null,
					})
				}
			}
			return index
		},
	}
}
