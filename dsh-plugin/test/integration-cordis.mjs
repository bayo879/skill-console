#!/usr/bin/env node
/**
 * 真 cordis 集成测试：把本插件挂到**本机真实的 cordis 实现**上，验证
 * 「未 inject 的服务读属性会抛」这条平台规则它真能扛住。
 *
 * 为什么单独有这个文件：`contract.mjs` 用的是我自己写的代理守卫，那是我对
 * cordis 语义的**模型**；模型会错，真实实现不会。第一次现场验证就是栽在
 * `ctx.webRuntime` 上（离线全绿、线上裸 400），所以这里直接 import 应用里那份
 * cordis，用真的 `ctx.provide()` / 真 fiber 树跑一遍。
 *
 * 只依赖本机应用自带的 cordis；找不到就跳过（退出码 0），不假装通过。
 *
 * 用法：node test/integration-cordis.mjs
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

const APP = '/Applications/DSH Desktop.app/Contents/Resources/app/node_modules/@deepseek-ai'
const CORDIS = join(APP, 'cordis', 'lib', 'index.js')
const LIB = join(import.meta.dirname, '..', 'lib')

let passed = 0
let failed = 0
function check(label, condition, detail = '') {
	if (condition) {
		passed += 1
		console.log(`  ✓ ${label}`)
	} else {
		failed += 1
		console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`)
	}
}

if (!existsSync(CORDIS)) {
	console.log(`跳过：本机没有 ${CORDIS}（真 cordis 集成测试只在装了 DSH Desktop 的机器上跑）`)
	process.exit(0)
}

const { Context } = await import(CORDIS)

/** 假的 node 请求。 */
function fakeReq({ method = 'GET', path = '/api/skill-console/state', host = '127.0.0.1:43129', headers = {} } = {}) {
	const listeners = {}
	const req = {
		method,
		url: path,
		headers: { host, ...headers },
		socket: { remoteAddress: '127.0.0.1' },
		on(event, handler) {
			listeners[event] = listeners[event] ?? []
			listeners[event].push(handler)
			return req
		},
		resume() {},
	}
	setImmediate(() => {
		for (const handler of listeners.data ?? []) handler(Buffer.from('', 'utf8'))
		for (const handler of listeners.end ?? []) handler()
	})
	return req
}

/** 假的 node 响应。 */
function fakeRes() {
	const res = { statusCode: 0, headers: null, body: '' }
	res.writeHead = (code, headers) => {
		res.statusCode = code
		res.headers = headers
	}
	res.end = (payload) => {
		res.body = payload ?? ''
	}
	return res
}

/**
 * 在真 cordis 里跑一次：`provideServices` 决定这个 fiber 提供了什么。
 * 刻意用真 `ctx.provide()`（走真 fiber store），而不是往对象上挂属性。
 */
async function runUnderCordis({ provideServices, request }) {
	let route = null
	const session = { id: 'integration-session', header: { id: 'integration-session', cwd: process.cwd(), updatedAt: 1 } }

	const services = {
		webServer: {
			host: '127.0.0.1',
			register: (registered) => {
				route = registered
				return () => {}
			},
		},
		skills: {
			registerProvider: (factory) => {
				factory({ signal: new AbortController().signal, invalidate() {} })
				return () => {}
			},
		},
		sessions: { list: () => [session], get: (id) => (id === session.id ? session : undefined) },
		...provideServices,
	}

	// 服务必须 provide 在**共同祖先**（这里就是 root）：cordis 是沿着 fiber 树向上找的，
	// 兄弟 fiber 提供的服务读不到——这正是线上 `webRuntime` 抛异常的那种情形。
	const root = new Context()
	for (const [serviceName, value] of Object.entries(services)) root.provide(serviceName, value)

	const plugin = await import(join(LIB, 'index.js'))
	// cordis 的 `ctx.plugin()` 返回可 await 的 fiber：await 它就等于「等这个插件的
	// 生命周期（inject 解析 + effect 安装）跑完」，不是靠猜时间。
	await root.plugin(plugin)

	if (route === null) return { route: null, diagnostics: `root.state=${root.fiber?.state} fibers=${root.fiber?.children?.length}` }
	const res = fakeRes()
	await route.handler(fakeReq(request), res)
	return { route, status: res.statusCode, body: res.body === '' ? null : JSON.parse(res.body) }
}

console.log('真 cordis 集成（应用自带实现）')

// 1) 只有必需服务、**没有** webRuntime：这是线上翻车过的组合。
//    修好之前这里会抛 cannot get property "webRuntime" without inject。
let threw = null
let noRuntime = null
try {
	noRuntime = await runUnderCordis({
		provideServices: {},
		request: { path: '/api/skill-console/state' },
	})
} catch (error) {
	threw = error instanceof Error ? error.message : String(error)
}
check('没有 webRuntime 时 apply + 请求不抛', threw === null, threw ?? '')
check('没有 webRuntime 时路由仍挂上', noRuntime?.route?.path === '/api/skill-console', `${String(noRuntime?.route?.path)} ${noRuntime?.diagnostics ?? ''}`)
check('没有 webRuntime 时 GET /state 返回 200 JSON 壳', noRuntime?.status === 200 && noRuntime?.body?.ok === true, `${noRuntime?.status} ${String(noRuntime?.body).slice(0, 160)}`)
check('回环 Host 被放行', noRuntime?.status === 200, String(noRuntime?.status))

// 2) 有 webRuntime：受信主机生效，且读它同样不抛。
const withRuntime = await runUnderCordis({
	provideServices: { webRuntime: { lanAddresses: ['10.0.0.5'], trustedHosts: ['10.0.0.5:43129'] } },
	request: { path: '/api/skill-console/state', host: '10.0.0.5:43129' },
})
check('有 webRuntime 时 apply + 请求不抛', withRuntime?.status === 200, `${withRuntime?.status} ${String(withRuntime?.body).slice(0, 160)}`)
check('真 webRuntime 的 trustedHosts 被真正读到（受信局域网主机放行）', withRuntime?.status === 200, String(withRuntime?.status))

// 3) 写路由的围栏在真 cordis 下同样生效。
const noMarker = await runUnderCordis({
	provideServices: {},
	request: { method: 'POST', path: '/api/skill-console/toggle' },
})
check('写操作缺标记仍 403（真 cordis 下）', noMarker?.status === 403 && noMarker?.body?.code === 'error.proto.forbidden', `${noMarker?.status} ${noMarker?.body?.code}`)

// 4) 畸形 URL：外层兜底必须把它变成 JSON 500，而不是让异常逃出 handler。
const malformed = await runUnderCordis({ provideServices: {}, request: { path: '//[' } })
check('畸形 URL 变成 JSON 500（异常不逃逸）', malformed?.status === 500 && malformed?.body?.code === 'error.internal', `${malformed?.status} ${JSON.stringify(malformed?.body)}`)

// 5) 角色读端点也必须能在真 cordis 下跑通（它比 /state 多读一个 sessions 之外的东西：角色状态文件）。
//    本用例会读真实 DSH_HOME 下的 roles.json（runUnderCordis 没设 DSH_HOME，回落 ~/.dsh），
//    但 GET /roles 不写任何东西——跑完检查 ~/.dsh/skill-console/ 不该多出文件。
const rolesUnderCordis = await runUnderCordis({
	provideServices: {},
	request: { path: '/api/skill-console/roles' },
})
check('真 cordis 下 GET /roles 返回 200 JSON 壳', rolesUnderCordis?.status === 200 && rolesUnderCordis?.body?.ok === true, `${rolesUnderCordis?.status} ${String(rolesUnderCordis?.body).slice(0, 200)}`)
check('GET /roles 带回三个契约字段', typeof rolesUnderCordis?.body?.data?.status === 'string' && Array.isArray(rolesUnderCordis?.body?.data?.roles) && typeof rolesUnderCordis?.body?.data?.candidates === 'object', `${rolesUnderCordis?.status} ${String(rolesUnderCordis?.body).slice(0, 200)}`)

// 6) 新增写路由必须在真 cordis 下也**按写路由**注册：缺标记头要 403，而不是 404/405。
//    这两条都完全不碰盘（连 body 都不读：标记围栏在 handler 之前）。
//    无需改假请求：`fakeReq` 本已支持 `method`/`headers`，`runUnderCordis` 也把整个 `request` 透传。
const skillDeleteUnderCordis = await runUnderCordis({
	provideServices: {},
	request: { method: 'POST', path: '/api/skill-console/skills/delete', headers: {} },
})
check('真 cordis 下 POST /skills/delete 缺标记头 → 403 JSON 壳', skillDeleteUnderCordis?.status === 403 && skillDeleteUnderCordis?.body?.ok === false, `${skillDeleteUnderCordis?.status} ${JSON.stringify(skillDeleteUnderCordis?.body).slice(0, 200)}`)

const moveUnderCordis = await runUnderCordis({
	provideServices: {},
	request: { method: 'GET', path: '/api/skill-console/skills/move-to-project' },
})
check('GET 打 /skills/move-to-project → 405（说明它登记在写路由表里）', moveUnderCordis?.status === 405, `${moveUnderCordis?.status} ${JSON.stringify(moveUnderCordis?.body).slice(0, 200)}`)

console.log(`\n结果：${passed}/${passed + failed} 项通过（真 cordis 集成）`)
if (failed > 0) process.exit(1)
