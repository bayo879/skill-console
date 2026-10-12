#!/usr/bin/env node
/**
 * 现场冒烟测试：打**真实运行中**的 DSH 的 HTTP 面，验证宿主半边真的在工作。
 *
 * 与 `contract.mjs` 的分工：
 *   - `contract.mjs` 离线、免 DSH，守逻辑与身份标识；
 *   - 本脚本**必须**有装好并重启过的 DSH，守「装上去真的能用」。
 *
 * 只读接口全测；写接口只碰一个**自己创建、自己删除**的临时技能
 * （`<DSH_HOME>/skills/zz-skill-console-smoke/`），并且：
 *   - 同名目录已存在就直接退出（绝不碰用户的真技能）；
 *   - 无论成败都在 finally 里整份删除。
 *
 * 用法：node test/smoke.mjs [baseUrl]
 *   默认 baseUrl = $DSH_WEB_URL 或 http://127.0.0.1:43129
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmdirSync, rmSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { dirname, join } from 'node:path'

const BASE = (process.argv[2] ?? process.env.DSH_WEB_URL ?? 'http://127.0.0.1:43129').replace(/\/+$/, '')
const FIXTURE = 'zz-skill-console-smoke'
const WRITE_HEADERS = { 'content-type': 'application/json', 'x-skill-console': '1' }

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
function section(title) {
	console.log(`\n${title}`)
}

/** 一次请求；返回 `{status, body}`（body 解析失败时为原始文本）。 */
async function call(path, options = {}) {
	const response = await fetch(`${BASE}${path}`, { cache: 'no-store', ...options })
	const text = await response.text()
	let body = null
	try {
		body = JSON.parse(text)
	} catch {
		body = text
	}
	return { status: response.status, body }
}

/**
 * 用原始 HTTP 请求发一次，**可以指定 Host**。
 * `fetch()` 会忽略调用方给的 Host（按 Fetch 规范它是禁用头），所以测围栏必须走这里。
 */
function rawWithHost(path, hostHeader) {
	return new Promise((resolve, reject) => {
		const parsed = new URL(BASE)
		const req = httpRequest(
			{ hostname: parsed.hostname, port: parsed.port, path, method: 'GET', headers: { Host: hostHeader } },
			(res) => {
				let text = ''
				res.setEncoding('utf8')
				res.on('data', (chunk) => { text += chunk })
				res.on('end', () => {
					let body = null
					try { body = JSON.parse(text) } catch { body = text }
					resolve({ status: res.statusCode, body })
				})
			},
		)
		req.on('error', reject)
		req.end()
	})
}

const sessionHeader = (sessionId) => (typeof sessionId === 'string' && sessionId !== '' ? { 'x-skill-console-session': sessionId } : {})
const FIXTURE_BODY = `---\nname: ${FIXTURE}\ndescription: dsh-skill-console 冒烟测试用的临时技能（脚本会自己删掉）\n---\n\n# smoke\n`

let fixtureDirCreated = null
let dshHomeFromState = null

try {
	section(`0. 连通性（${BASE}）`)
	let state
	try {
		state = await call('/api/skill-console/state')
	} catch (error) {
		console.error(`\n连不上 ${BASE}：${error.message}`)
		console.error('先确认 DSH 已启动、且本插件已安装并**重启**过（bundle 列表只在启动时读一次）。')
		process.exit(2)
	}
	check('GET /state 返回 200', state.status === 200, `http=${state.status} body=${JSON.stringify(state.body).slice(0, 120)}`)
	if (state.status !== 200) {
		console.error('\n路由没挂上：插件可能没被加载（检查设置里的插件列表 / 重启 DSH）。')
		process.exit(2)
	}
	check('响应壳是 {ok:true,data}', state.body?.ok === true)
	const info = state.body.data
	// 项目根只在「能从会话 cwd 找到项目根」时出现（要求有 .git 之类），
	// 所以这里断言的是不依赖环境的不变量，而不是固定 4 个。
	const rootKeys = info.roots.map((root) => root.key)
	check('全局 DSH 根总在', rootKeys.includes('user-dsh'), rootKeys.join(','))
	check('全局根排在项目根前面', rootKeys.indexOf('user-dsh') < (rootKeys.indexOf('project-dsh') === -1 ? rootKeys.length : rootKeys.indexOf('project-dsh')), rootKeys.join(','))
	check('根按契约顺序排列', rootKeys.join(',') === 'user-dsh,project-dsh'.split(',').filter((key) => rootKeys.includes(key)).join(','), rootKeys.join(','))
	check('.agents 不再是技能根', !rootKeys.some((key) => key.includes('agents')) && !info.roots.some((root) => root.path.includes('.agents')), rootKeys.join(','))
	check('/state 不再回显 agentsHome', !('agentsHome' in info), JSON.stringify(Object.keys(info)))
	check('每个根都带契约字段 key/scope/label/path/exists/writable', info.roots.every((root) => ['key', 'scope', 'label', 'path', 'exists', 'writable'].every((field) => field in root) && typeof root.exists === 'boolean' && root.writable === true), JSON.stringify(info.roots[0]))
	check('报告了 dshHome（DSH Desktop 的真实值）', typeof info.dshHome === 'string' && info.dshHome !== '', info.dshHome)
	check('skillsDir 与 dshHome 一致', info.skillsDir === join(info.dshHome, 'skills'), info.skillsDir)
	check('stateDir 在 dshHome 下', info.stateDir === join(info.dshHome, 'skill-console'), info.stateDir)
	check('token 只报存在性、不回显值', typeof info.token === 'boolean')
	check('报告了工作区列表（注册表或活着的会话）', Array.isArray(info.workspaces))
	check('未指定会话时给出 fallback 选择', info.selected === null || typeof info.selected.fallback === 'boolean')

	// 用本会话 id 钉住项目：能钉上时才要求项目根齐全（否则是环境问题，不是插件问题）。
	const sessionId = process.env.DSH_SESSION_ID
	if (typeof sessionId === 'string' && sessionId !== '') {
		const pinned = await call('/api/skill-console/state', { headers: { 'x-skill-console-session': sessionId } })
		check('用本会话 id 请求 /state 返回 200', pinned.status === 200, String(pinned.status))
		const pinnedRoots = pinned.body.data.roots.map((root) => root.key)
		check('钉住本会话后不是 fallback', pinned.body.data.selected?.fallback === false, JSON.stringify(pinned.body.data.selected))
		check('钉住本会话后项目根齐全（cwd 能解析出项目）', pinnedRoots.length === 2, pinnedRoots.join(','))
		check('项目根落在本工作区里', pinned.body.data.roots.filter((root) => root.scope === 'project').every((root) => root.path.includes('Documents/code/ai/agents/dsh')), JSON.stringify(pinned.body.data.roots.filter((root) => root.scope === 'project').map((root) => root.path)))
	}
	dshHomeFromState = info.dshHome

	section('1. 只读接口')
	const globalCatalog = await call('/api/skill-console/catalog?scope=global')
	check('GET /catalog?scope=global 返回 200', globalCatalog.status === 200)
	check('只回全局根', globalCatalog.body.data.roots.every((root) => root.scope === 'global'), globalCatalog.body.data.roots.map((r) => r.key).join(','))
	const allGlobalSkills = globalCatalog.body.data.roots.flatMap((root) => root.skills)
	check('技能行带齐契约字段', allGlobalSkills.every((skill) => ['name', 'path', 'enabled', 'kind', 'toggleable', 'root', 'scope', 'installed'].every((key) => key in skill)))
	check('kind 只有 directory / flat', allGlobalSkills.every((skill) => skill.kind === 'directory' || skill.kind === 'flat'), [...new Set(allGlobalSkills.map((s) => s.kind))].join(','))
	check('enabled 与 path 一致（.disabled 后缀才算关闭）', allGlobalSkills.every((skill) => skill.enabled === !/\.disabled$/.test(skill.path)), allGlobalSkills.filter((skill) => skill.enabled !== !/\.disabled$/.test(skill.path)).map((skill) => skill.path).join(','))
	const projectCatalog = await call('/api/skill-console/catalog?scope=project')
	check('GET /catalog?scope=project 返回 200', projectCatalog.status === 200)
	check('项目 scope 带回 project 对象或 null', 'project' in projectCatalog.body.data)
	const repos = await call('/api/skill-console/repositories')
	check('GET /repositories 返回 200', repos.status === 200 && Array.isArray(repos.body.data.repositories))
	check('订阅上限来自宿主常量', repos.body.data.maxRepositories === 100, String(repos.body.data.maxRepositories))
	const backups = await call(`/api/skill-console/backups?name=${FIXTURE}`)
	check('GET /backups 对没装过的技能返回空列表（不报错）', backups.status === 200 && backups.body.data.backups.length === 0)

	const outside = await call(`/api/skill-console/skill?path=${encodeURIComponent('/etc/hosts')}`)
	check('读根外文件被拒（400 error.path.outsideRoots）', outside.status === 400 && outside.body.code === 'error.path.outsideRoots', `${outside.status} ${outside.body?.code}`)
	const unknown = await call('/api/skill-console/nope')
	check('未知路由 404', unknown.status === 404 && unknown.body.code === 'error.proto.unknownRoute')
	const badAdd = await call('/api/skill-console/repositories/add', { method: 'POST', headers: WRITE_HEADERS, body: JSON.stringify({ url: 'not a repo' }) })
	check('POST /repositories/add 非法地址 400（且不联网）', badAdd.status === 400 && badAdd.body.code === 'error.repo.url', `${badAdd.status} ${badAdd.body?.code}`)

	// 新增的破坏性端点**绝不在**真实工作区里试：冒烟打的是用户真正的 DSH 与工作区。
	// 只验「这些路径确实挂在写路由上、围栏在前」——一个字节都不落盘。
	const deleteWithoutMarker = await call('/api/skill-console/skills/delete', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ path: '/definitely/not/a/skill/SKILL.md' }),
	})
	check('POST /skills/delete 缺标记头 → 403（围栏在前，没走到删除）', deleteWithoutMarker.status === 403, `http=${deleteWithoutMarker.status}`)
	const deleteWithoutPath = await call('/api/skill-console/skills/delete', {
		method: 'POST',
		headers: { ...WRITE_HEADERS, ...sessionHeader(sessionId) },
		body: JSON.stringify({}),
	})
	check('POST /skills/delete 缺 path → 400 error.proto.missingPath（没删任何东西）', deleteWithoutPath.status === 400 && deleteWithoutPath.body?.code === 'error.proto.missingPath', `http=${deleteWithoutPath.status} ${JSON.stringify(deleteWithoutPath.body).slice(0, 120)}`)
	const moveNotGlobal = await call('/api/skill-console/skills/move-to-project', {
		method: 'POST',
		headers: { ...WRITE_HEADERS, ...sessionHeader(sessionId) },
		body: JSON.stringify({}),
	})
	check('POST /skills/move-to-project 缺 path → 400（没移动任何东西）', moveNotGlobal.status === 400 && moveNotGlobal.body?.code === 'error.proto.missingPath', `http=${moveNotGlobal.status} ${JSON.stringify(moveNotGlobal.body).slice(0, 120)}`)

	section('2. 写操作围栏')
	const noMarker = await call('/api/skill-console/toggle', { method: 'POST', body: JSON.stringify({ path: '/tmp/x', enabled: false }) })
	check('写操作缺客户端标记被拒（403 error.proto.forbidden）', noMarker.status === 403 && noMarker.body.code === 'error.proto.forbidden', `${noMarker.status} ${noMarker.body?.code}`)
	const wrongType = await call('/api/skill-console/toggle', { method: 'POST', headers: { 'x-skill-console': '1', 'content-type': 'text/plain' }, body: '{}' })
	check('写操作 content-type 不对被拒（415）', wrongType.status === 415 && wrongType.body.code === 'error.proto.contentType', `${wrongType.status} ${wrongType.body?.code}`)
	// 注意：fetch() 会**忽略**调用方给的 Host 头（undici 按 Fetch 规范把它当禁用头），
	// 所以这里必须用 node:http 发原始请求，否则测的是「Host 仍是 127.0.0.1」。
	const badHost = await rawWithHost('/api/skill-console/state', 'evil.example.com')
	check('非回环 Host 被拒（403）', badHost.status === 403 && badHost.body?.code === 'error.proto.forbiddenHost', `http=${badHost.status} ${JSON.stringify(badHost.body)}`)
	const lanHost = await rawWithHost('/api/skill-console/state', '10.0.0.5:43129')
	check('不在受信名单的局域网 Host 也被拒（403）', lanHost.status === 403, `http=${lanHost.status}`)

	section('3. 启停真技能文件（自建自删的临时技能）')
	// 用项目根而不是全局根：一是它在工作区内（不碰用户的全局技能目录），
	// 二是顺便把「项目 scope」这条更复杂的路径也验证了。
	const pinned = await call('/api/skill-console/state', { headers: sessionHeader(sessionId) })
	const projectRoot = pinned.body.data.roots.find((root) => root.key === 'project-dsh')
	if (projectRoot === undefined) {
		console.log('  跳过：解析不出项目根（当前会话 cwd 不在任何项目里），写路径未验证')
	} else {
		const scopeQuery = 'scope=project'
		const fixtureDir = join(projectRoot.path, FIXTURE)
		const target = join(fixtureDir, 'SKILL.md')
		if (existsSync(fixtureDir)) {
			console.error(`\n同名技能已存在，拒绝覆盖：${fixtureDir}`)
			console.error('请手动确认并删除它之后重跑本脚本。')
			process.exit(3)
		}
		mkdirSync(fixtureDir, { recursive: true })
		writeFileSync(target, FIXTURE_BODY)
		fixtureDirCreated = fixtureDir

		const seen = await call(`/api/skill-console/catalog?${scopeQuery}`, { headers: sessionHeader(sessionId) })
		const fixtureRow = seen.body.data.roots.flatMap((root) => root.skills).find((skill) => skill.name === FIXTURE)
		check('新建的项目技能出现在项目目录里', fixtureRow !== undefined, JSON.stringify(seen.body.data.roots.map((root) => `${root.key}:${root.skills.length}`)))
		check('新技能是已启用状态', fixtureRow?.enabled === true)
		check('未安装于任何订阅（installed 为 null）', fixtureRow?.installed === null, JSON.stringify(fixtureRow?.installed))

		// 必须带会话头：不带时宿主回落到「最近一个会话」，那个会话的项目根可能不是本工作区，
		// 于是这条读请求会以 error.path.outsideRoots 失败——那是环境差异，不是插件坏了。
		const read = await call(`/api/skill-console/skill?path=${encodeURIComponent(target)}`, { headers: sessionHeader(sessionId) })
		check('GET /skill 带回正文与 frontmatter', read.status === 200 && typeof read.body.data.body === 'string' && typeof read.body.data.frontmatter === 'string')
		check('正文里没有 frontmatter 围栏', !read.body.data.body.includes('---'), JSON.stringify(read.body.data.body.slice(0, 40)))

		const off = await call('/api/skill-console/toggle', { method: 'POST', headers: { ...WRITE_HEADERS, ...sessionHeader(sessionId) }, body: JSON.stringify({ path: target, enabled: false }) })
		check('POST /toggle 关闭项目技能成功', off.status === 200 && off.body.data.skill.enabled === false, `${off.status} ${JSON.stringify(off.body).slice(0, 140)}`)
		check('落盘为 SKILL.md.disabled', existsSync(`${target}.disabled`) && !existsSync(target))
		check('改名不改内容（逐字节相同）', readFileSync(`${target}.disabled`, 'utf8') === FIXTURE_BODY)
		check('响应路径指向 .disabled', off.body.data.skill.path === `${target}.disabled`, off.body.data.skill.path)

		const offCatalog = await call(`/api/skill-console/catalog?${scopeQuery}`, { headers: sessionHeader(sessionId) })
		const offRow = offCatalog.body.data.roots.flatMap((root) => root.skills).find((skill) => skill.name === FIXTURE)
		check('关闭后仍在列表里、但标记为未启用', offRow?.enabled === false, JSON.stringify(offRow))
		check('关闭的副本不参与同名覆盖', !offCatalog.body.data.collisions.some((entry) => entry.name === FIXTURE))

		const on = await call('/api/skill-console/toggle', { method: 'POST', headers: { ...WRITE_HEADERS, ...sessionHeader(sessionId) }, body: JSON.stringify({ path: `${target}.disabled`, enabled: true }) })
		check('POST /toggle 再启用成功', on.status === 200 && on.body.data.skill.enabled === true, `${on.status} ${JSON.stringify(on.body).slice(0, 140)}`)
		check('文件改回 SKILL.md', existsSync(target) && !existsSync(`${target}.disabled`))
		check('内容依然一模一样', readFileSync(target, 'utf8') === FIXTURE_BODY)

		const batch = await call('/api/skill-console/toggle-batch', {
			method: 'POST',
			headers: { ...WRITE_HEADERS, ...sessionHeader(sessionId) },
			body: JSON.stringify({ items: [{ path: target, enabled: false }, { path: '/etc/hosts', enabled: false }] }),
		})
		check('POST /toggle-batch 逐项报告', batch.status === 200 && batch.body.data.results.length === 2, JSON.stringify(batch.body).slice(0, 160))
		check('批量里合法项成功', batch.body.data.results[0].ok === true)
		check('批量里越界项给了错误码', batch.body.data.results[1].ok === false && batch.body.data.results[1].code === 'error.path.outsideRoots', batch.body.data.results[1].code)
		check('批量真的改了盘', existsSync(`${target}.disabled`))
		await call('/api/skill-console/toggle', { method: 'POST', headers: { ...WRITE_HEADERS, ...sessionHeader(sessionId) }, body: JSON.stringify({ path: `${target}.disabled`, enabled: true }) })
		check('批量后能改回来', existsSync(target))
	}

	section('4. 角色：非破坏性往返')
	// 为什么**不**在这里测真实的角色切换：`activate` 会把项目技能根里「角色外」的
	// 技能全部停用，而冒烟测试打的是用户真实的工作区。为了测一个接口把用户的技能
	// 关掉一批，代价完全不成比例。所以这里只走「读了什么都不改」的路径：
	//   1. 用当前**已启用**的项目技能拼一个角色（切换它 = 零动作）；
	//   2. activate 它，断言 changed === 0（既验证了写路径，又保证盘上一个字节没动）；
	//   3. deactivate + remove 收尾。
	// 真正的对齐语义由 contract.mjs 在临时目录里覆盖，另有 README 的手工验收清单。
	const roleFixtureName = 'zz-skill-console-smoke-role'
	const rolesBefore = await call('/api/skill-console/roles', { headers: sessionHeader(sessionId) })
	check('GET /roles 返回 200', rolesBefore.status === 200 && rolesBefore.body?.ok === true, `http=${rolesBefore.status}`)
	check('角色列表是数组', Array.isArray(rolesBefore.body?.data?.roles))
	check('候选里项目技能与全局技能分开', Array.isArray(rolesBefore.body?.data?.candidates?.project) && Array.isArray(rolesBefore.body?.data?.candidates?.global))
	check('全局候选与项目候选同形状（可勾选，不再标只读）', (rolesBefore.body?.data?.candidates?.global ?? []).every((entry) => !('readOnly' in entry) && !('reason' in entry) && 'toggleable' in entry && 'readOnlyReason' in entry))
	if (rolesBefore.body?.data?.roles?.some((role) => role.name === roleFixtureName)) {
		console.error(`\n同名角色已存在，拒绝覆盖：${roleFixtureName}`)
		console.error('请先在面板里删除它，或手工编辑 roles.json 后重跑。')
		process.exit(3)
	}

	const enabledProjectSkills = (rolesBefore.body?.data?.candidates?.project ?? []).filter((entry) => entry.enabled === true && entry.toggleable === true)
	if (enabledProjectSkills.length === 0) {
		console.log('  跳过：本项目没有已启用的技能可用来拼零动作角色')
	} else {
		const saved = await call('/api/skill-console/roles/save', {
			method: 'POST',
			headers: { ...WRITE_HEADERS, ...sessionHeader(sessionId) },
			body: JSON.stringify({ name: roleFixtureName, skills: enabledProjectSkills.map((entry) => entry.name) }),
		})
		check('POST /roles/save 建角色成功', saved.status === 200 && typeof saved.body?.data?.role?.id === 'string', JSON.stringify(saved.body).slice(0, 160))
		const roleFixtureId = saved.body?.data?.role?.id

		const preview = await call(`/api/skill-console/roles/preview?role=${encodeURIComponent(roleFixtureId)}`, { headers: sessionHeader(sessionId) })
		check('GET /roles/preview 返回 200 且零动作', preview.status === 200 && preview.body?.data?.steps?.length === 0, JSON.stringify(preview.body?.data?.steps).slice(0, 200))

		const activated = await call('/api/skill-console/roles/activate', {
			method: 'POST',
			headers: { ...WRITE_HEADERS, ...sessionHeader(sessionId) },
			body: JSON.stringify({ id: roleFixtureId }),
		})
		check('POST /roles/activate 返回 200', activated.status === 200 && activated.body?.ok === true, JSON.stringify(activated.body).slice(0, 200))
		check('零动作切换没有改任何文件（changed === 0）', activated.body?.data?.changed === 0, String(activated.body?.data?.changed))
		check('零动作切换后状态是 matched', activated.body?.data?.status === 'matched', String(activated.body?.data?.status))

		const cleared = await call('/api/skill-console/roles/deactivate', { method: 'POST', headers: { ...WRITE_HEADERS, ...sessionHeader(sessionId) }, body: '{}' })
		check('POST /roles/deactivate 返回 200', cleared.status === 200 && cleared.body?.ok === true, JSON.stringify(cleared.body).slice(0, 160))
		const removed = await call('/api/skill-console/roles/remove', { method: 'POST', headers: { ...WRITE_HEADERS, ...sessionHeader(sessionId) }, body: JSON.stringify({ id: roleFixtureId }) })
		check('POST /roles/remove 返回 200', removed.status === 200 && removed.body?.ok === true, JSON.stringify(removed.body).slice(0, 160))
		check('角色已清干净', (await call('/api/skill-console/roles', { headers: sessionHeader(sessionId) })).body?.data?.roles?.every((role) => role.name !== roleFixtureName) === true)
	}

	section('5. 与已装技能管理器共存')
	const other = await call('/api/dsh-skills-manager/state')
	check('@michengai/dsh-skills-manager 的接口仍然可用（两个分区并存）', other.status === 200 && other.body?.ok === true, `http=${other.status}`)
	check('两个插件报的是同一个 DSH_HOME', other.body?.data?.roots?.[0]?.path?.startsWith(dshHomeFromState) === true, other.body?.data?.roots?.[0]?.path)
} finally {
	// 无论成败都要把自己的临时技能删干净。
	if (fixtureDirCreated !== null) {
		rmSync(fixtureDirCreated, { recursive: true, force: true })
		rmSync(`${fixtureDirCreated}.md`, { force: true })
		const leftover = existsSync(fixtureDirCreated)
		console.log(`\n清理：${leftover ? '✗ 未能删除' : '✓ 已删除'} ${fixtureDirCreated}`)
		if (leftover) failed += 1
		// 顺手把空的项目技能目录也收掉，别给工作区留垃圾。
		const parent = dirname(fixtureDirCreated)
		try {
			if (existsSync(parent) && readdirSync(parent).length === 0) rmdirSync(parent)
		} catch {
			// 目录非空或被占用：留着不算失败。
		}
	}
}

console.log(`\n结果：${passed}/${passed + failed} 项通过（${BASE}）`)
if (failed > 0) process.exit(1)
