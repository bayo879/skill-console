/**
 * GitHub 客户端：地址解析、API 调用、原始内容下载、git blob 哈希。
 *
 * 只有公开仓库这一条路（不处理私有凭证之外的鉴权），token 是可选的：
 * 公开仓库读 raw 内容本来就不需要它，只有 API 限流时才用得上。
 *
 * 完整性：tree API 给出每个 blob 的 git SHA-1（`sha1("blob <len>\0" + content)`）。
 * 下载后用同一个算法复算并比对，对不上就整项失败——半截内容不会落盘。
 */

import { errorText, httpError } from './http.js'

// 哈希算法在 gitsha.js 里（备份侧也要用同一份），这里转出去方便调用方只认本模块。
export { gitBlobSha1, gitBlobSha1OfText } from './gitsha.js'

/** GitHub REST 端点。 */
export const API_BASE = 'https://api.github.com'
/** 原始内容端点（不走 API 限流，公开仓库免鉴权）。 */
export const RAW_BASE = 'https://raw.githubusercontent.com'

/** 单文件上限（超过就拒绝，避免把整个仓库拖进来）。 */
export const MAX_FILE_BYTES = 4 * 1024 * 1024

/** 环境变量里的 GitHub token（公开仓库其实不需要；限流时才用得上）。 */
export function readToken(env = process.env) {
	const value = env.DSH_SKILL_CONSOLE_GITHUB_TOKEN?.trim() || env.GITHUB_TOKEN?.trim()
	return value ? value : null
}

/**
 * 解析仓库地址。支持 `owner/name`、`https://github.com/owner/name`、
 * `git@github.com:owner/name.git`、以及带 `/tree/<ref>/<subdir>` 的网页地址。
 * @param input - 用户输入。
 * @returns `{owner, name, ref, subdirectory}` 或 null。
 */
export function parseRepositoryInput(input) {
	const raw = typeof input === 'string' ? input.trim() : ''
	if (raw === '') return null
	let text = raw
	let ref = ''
	let subdirectory = ''
	const ssh = /^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/.exec(text)
	if (ssh) {
		text = `${ssh[1]}/${ssh[2]}`
	} else if (/^https?:\/\//i.test(text) || text.startsWith('github.com/')) {
		const url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`)
		if (url.hostname !== 'github.com' && url.hostname !== 'www.github.com') return null
		const parts = url.pathname.split('/').filter(Boolean)
		if (parts.length < 2) return null
		const treeIndex = parts.indexOf('tree')
		if (treeIndex >= 0) {
			ref = parts[treeIndex + 1] ?? ''
			subdirectory = parts.slice(treeIndex + 2).join('/')
		}
		text = `${parts[0]}/${parts[1]}`
	}
	text = text.replace(/\.git$/, '').replace(/\/+$/, '')
	const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(text)
	if (match === null) return null
	return { owner: match[1], name: match[2], ref, subdirectory }
}

/**
 * 创建一个 GitHub 客户端。
 * @param options - `{fetchImpl, tokenOf, log}`；`fetchImpl` 可注入（离线测试用桩）。
 * @returns 客户端方法集。
 */
export function createGitHubClient(options = {}) {
	const fetchImpl = options.fetchImpl ?? globalThis.fetch
	const tokenOf = typeof options.tokenOf === 'function' ? options.tokenOf : () => null
	const log = typeof options.log === 'function' ? options.log : () => {}

	/** 一次 GitHub API 调用（错误码映射成前端认识的形状）。 */
	async function apiJson(pathname) {
		const url = pathname.startsWith('http') ? pathname : `${API_BASE}${pathname}`
		const headers = {
			accept: 'application/vnd.github+json',
			'user-agent': 'dsh-skill-console',
			'x-github-api-version': '2022-11-28',
		}
		const token = tokenOf()
		if (token !== null) headers.authorization = `Bearer ${token}`
		let response
		try {
			response = await fetchImpl(url, { headers })
		} catch (error) {
			throw httpError(502, 'error.repo.network', `连不上 GitHub：${errorText(error)}`)
		}
		if (response.status === 404) throw httpError(502, 'error.repo.notFound', `GitHub 上找不到：${pathname}`)
		if (response.status === 403 || response.status === 429) {
			const remaining = typeof response.headers?.get === 'function' ? response.headers.get('x-ratelimit-remaining') : null
			if (response.status === 429 || remaining === '0') {
				throw httpError(502, 'error.repo.rateLimit', 'GitHub API 限流了：可以配 DSH_SKILL_CONSOLE_GITHUB_TOKEN（或 GITHUB_TOKEN）后重试')
			}
		}
		if (!response.ok) throw httpError(502, 'error.repo.network', `GitHub API 返回 HTTP ${response.status}：${pathname}`)
		return response.json()
	}

	/** 下载一个原始文件（带大小上限）。 */
	async function download(url, limitBytes = MAX_FILE_BYTES) {
		const headers = { 'user-agent': 'dsh-skill-console' }
		const token = tokenOf()
		if (token !== null) headers.authorization = `Bearer ${token}`
		let response
		try {
			response = await fetchImpl(url, { headers })
		} catch (error) {
			throw httpError(502, 'error.repo.network', `下载失败：${errorText(error)}`)
		}
		if (response.status === 404) throw httpError(502, 'error.repo.notFound', `仓库里没有这个文件：${url}`)
		if (!response.ok) throw httpError(502, 'error.repo.network', `下载失败 HTTP ${response.status}：${url}`)
		const buffer = Buffer.from(await response.arrayBuffer())
		if (buffer.length > limitBytes) throw httpError(502, 'error.install.tooLarge', `文件超过上限（${limitBytes} 字节）：${url}`)
		return buffer
	}

	/** raw 内容地址（固定到 commit，保证清单与内容一致）。 */
	function rawUrl(owner, name, commit, repoPath) {
		const encoded = repoPath.split('/').map(encodeURIComponent).join('/')
		return `${RAW_BASE}/${owner}/${name}/${commit}/${encoded}`
	}

	/** 默认分支。 */
	async function defaultBranch(owner, name) {
		const info = await apiJson(`/repos/${owner}/${name}`)
		return typeof info?.default_branch === 'string' && info.default_branch !== '' ? info.default_branch : 'HEAD'
	}

	/** 把 ref 解析成一个具体 commit。 */
	async function resolveCommit(owner, name, ref) {
		const info = await apiJson(`/repos/${owner}/${name}/commits/${encodeURIComponent(ref)}`)
		const sha = typeof info?.sha === 'string' ? info.sha : null
		if (sha === null) throw httpError(502, 'error.repo.network', 'GitHub 没给出 commit sha')
		return {
			sha,
			message: typeof info?.commit?.message === 'string' ? info.commit.message.split('\n')[0] : '',
			date: info?.commit?.committer?.date ?? info?.commit?.author?.date ?? null,
		}
	}

	/** 递归树（list 型）。 */
	async function tree(owner, name, sha) {
		const result = await apiJson(`/repos/${owner}/${name}/git/trees/${sha}?recursive=1`)
		if (!Array.isArray(result?.tree)) throw httpError(502, 'error.repo.network', 'GitHub 返回的 tree 形状不认识')
		if (result.truncated === true) log(`${owner}/${name}: GitHub 标记 tree 被截断，清单可能不完整`)
		return result.tree
	}

	return { apiJson, download, rawUrl, defaultBranch, resolveCommit, tree }
}
