/**
 * HTTP 平面：错误形状、回环围栏、请求体、响应。
 *
 * 与技能/仓库**无关**的通用件都放这里，`index.js` 与 `routes.js` 共用。
 * 回环围栏的语义与 dsh-skill-hub / dsh-skills-manager 一致：Host 必须解析到
 * 回环（或部署声明的可信主机）、拒绝 `sec-fetch-site: cross-site`、带 `Origin`
 * 时主机名必须与 Host 一致。
 *
 * 这是 **DNS-rebinding / 跨站防御，不是认证**——所以本插件只在回环部署下有意义；
 * `--host 0.0.0.0` 把 DSH 暴露到局域网时不要依赖它。
 */

/** 客户端标记头：写操作必须带（跨站表单伪造不出自定义头 + JSON content-type）。 */
export const CLIENT_HEADER = 'x-skill-console'

/** 请求体上限（这些接口的请求体都很小）。 */
export const MAX_BODY_BYTES = 1024 * 1024

/** 构造一个带 HTTP 语义的错误（路由层统一转 JSON）。 */
export function httpError(statusCode, code, message) {
	const error = new Error(message)
	error.statusCode = statusCode
	error.code = code
	return error
}

/** 错误文本。 */
export function errorText(error) {
	return error instanceof Error ? error.message : String(error)
}

/** 回环主机名判定（`localhost` / `[::1]` / `127.0.0.0/8`）。 */
export function isLoopbackHostname(hostname) {
	if (hostname === 'localhost' || hostname === '[::1]') return true
	const parts = hostname.split('.')
	return parts.length === 4 && parts[0] === '127' && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/** `host[:port]` 解析；解析不出来返回 undefined。 */
export function parseAuthority(authority) {
	try {
		return new URL(`http://${authority}`)
	} catch {
		return undefined
	}
}

/**
 * 回环 + 可信 Host 围栏。
 * @param req - node HTTP 请求。
 * @param trustedHosts - `ctx.webRuntime.trustedHosts`（可为空）。
 * @returns 拒绝原因或 null。
 */
/**
 * 读「额外受信主机」这份可选配置。
 *
 * 为什么不直接写 `ctx.webRuntime?.trustedHosts`：cordis 对**未声明 inject** 的服务，
 * 读属性的那一刻就抛 `cannot get property "webRuntime" without inject`——`?.` 拦不住，
 * 因为要在拿到值之前抛。可选服务必须走核心的 `ctx.get(name, false)`：
 * 它不需要 inject，服务不存在时返回 `undefined`，也不要求提供方 fiber 已 active。
 *
 * @param ctx - 插件上下文。
 * @returns 受信主机列表（拿不到就是空列表）。
 */
export function trustedHostsOf(ctx) {
	const runtime = typeof ctx?.get === 'function' ? ctx.get('webRuntime', false) : undefined
	const list = runtime?.trustedHosts
	return Array.isArray(list) ? list : []
}

export function validateRequestOrigin(req, trustedHosts = []) {
	const host = typeof req.headers?.host === 'string' ? req.headers.host : ''
	const hostUrl = parseAuthority(host)
	if (hostUrl === undefined) return { statusCode: 403, code: 'error.proto.forbiddenHost', error: 'forbidden host' }
	const loopback = isLoopbackHostname(hostUrl.hostname)
	const trusted =
		Array.isArray(trustedHosts) &&
		trustedHosts.some((entry) => {
			if (typeof entry !== 'string') return false
			const parsed = parseAuthority(entry)
			return parsed !== undefined && parsed.host === hostUrl.host
		})
	if (!loopback && !trusted) return { statusCode: 403, code: 'error.proto.forbiddenHost', error: 'forbidden host' }
	if (req.headers?.['sec-fetch-site'] === 'cross-site') {
		return { statusCode: 403, code: 'error.proto.forbiddenHost', error: 'forbidden host' }
	}
	const origin = req.headers?.origin
	if (typeof origin === 'string') {
		try {
			if (new URL(origin).host !== hostUrl.host) return { statusCode: 403, code: 'error.proto.forbiddenHost', error: 'forbidden host' }
		} catch {
			return { statusCode: 403, code: 'error.proto.forbiddenHost', error: 'forbidden host' }
		}
	}
	return null
}

/**
 * 写操作的前置检查：客户端标记 + JSON content-type。
 * @param req - node HTTP 请求。
 * @returns 拒绝原因或 null。
 */
export function validateMutation(req) {
	if (req.headers?.[CLIENT_HEADER] !== '1') {
		return { statusCode: 403, code: 'error.proto.forbidden', error: '缺少客户端标记（x-skill-console: 1）' }
	}
	const contentType = String(req.headers?.['content-type'] ?? '')
		.split(';', 1)[0]
		.trim()
		.toLowerCase()
	if (contentType !== 'application/json') {
		return { statusCode: 415, code: 'error.proto.contentType', error: 'content-type 必须是 application/json' }
	}
	return null
}

/** 写一个 JSON 响应（连接已结束时静默跳过）。 */
export function writeJson(res, statusCode, payload) {
	if (!res || res.writableEnded || res.destroyed) return
	try {
		const body = JSON.stringify(payload)
		res.writeHead(statusCode, {
			'content-type': 'application/json; charset=utf-8',
			'content-length': Buffer.byteLength(body),
			'cache-control': 'no-store',
			'referrer-policy': 'no-referrer',
		})
		res.end(body)
	} catch {
		// 连接已经断了：没有可做的事，也不该抛。
	}
}

/**
 * 读请求体并解析 JSON（带上限）。
 * @param req - node HTTP 请求。
 * @param maxBytes - 上限，默认 `MAX_BODY_BYTES`。
 * @returns 解析出的对象。
 */
export function readJsonBody(req, maxBytes = MAX_BODY_BYTES) {
	return new Promise((resolve, reject) => {
		const chunks = []
		let size = 0
		let settled = false
		const fail = (error) => {
			if (settled) return
			settled = true
			reject(error)
		}
		req.on('data', (chunk) => {
			if (settled) return
			size += chunk.length
			if (size > maxBytes) {
				fail(httpError(413, 'error.proto.bodyTooLarge', `请求体超过 ${maxBytes} 字节`))
				req.resume()
				return
			}
			chunks.push(chunk)
		})
		req.on('end', () => {
			if (settled) return
			try {
				const raw = Buffer.concat(chunks).toString('utf8')
				settled = true
				resolve(raw === '' ? {} : JSON.parse(raw))
			} catch (error) {
				fail(httpError(400, 'error.proto.invalidJson', `请求体不是合法 JSON：${errorText(error)}`))
			}
		})
		req.on('error', fail)
	})
}
