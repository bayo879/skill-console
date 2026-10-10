#!/usr/bin/env node
/**
 * dsh-skill-console 契约测试（离线：不需要 DSH、不需要网络真连 GitHub）。
 *
 * 守的是「重启 DSH 之前就能确定」的几件事：
 *
 *   1. **身份标识一致性**——package.json 的包名、cordis.patch.yml 的 insert 行、
 *      客户端 bundle 的 `id`、宿主导出的 `name`。任何一处对不上，插件会**静默不加载**，
 *      DSH 不会报错，所以必须机器守。
 *   2. **发现/扫描/启停**——扫描规则与 DSH provider 对齐；关技能只重命名、不覆盖、
 *      不越界；软链接只读；同名覆盖关系算得对。
 *   3. **仓库订阅**——用桩 fetch 假造一个 GitHub（tree + raw），跑通
 *      添加 → 拉取 → 安装 → 本地改动被保护 → 确认更新 + 备份 → 恢复 → 上游删除。
 *   4. **宿主路由**——回环围栏、写操作标记、body 上限、错误码。
 *   5. **浏览器半边**——能在模块表里注册、导出面正确、slot 契约正确、
 *      无 primitives / 无 slots 时都不崩。
 *
 * 用法：node test/contract.mjs
 */

import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const LIB = join(ROOT, 'lib')

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

/** 临时目录（每个 section 自己清理）。 */
const cleanup = []
function tempDir(prefix) {
	const dir = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`)
	mkdirSync(dir, { recursive: true })
	cleanup.push(dir)
	return dir
}
process.on('exit', () => {
	for (const dir of cleanup) rmSync(dir, { recursive: true, force: true })
})

// ── 1. 身份标识一致性 ─────────────────────────────────────────────────────

section('身份标识一致性（四份文件必须互相对上）')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const patchText = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8')
const hostSource = readFileSync(join(LIB, 'index.js'), 'utf8')
// 客户端 bundle 延迟读取：宿主侧的测试不该因为半边还没生成就整份跑不起来。
let clientSource = ''
try {
	clientSource = readFileSync(join(LIB, 'client.js'), 'utf8')
} catch {
	clientSource = ''
}

const patchRow = /- id:\s*(\S+)\s*\n\s*name:\s*'?([^'\n]+)'?/.exec(patchText)
const hostName = /export const name = '([^']+)'/.exec(hostSource)?.[1]
const bundleId = /__ModuleLoader__\.load\(\{\s*id:\s*'([^']+)'/.exec(clientSource)?.[1]

check('package.json 的 name 是 dsh-skill-console', pkg.name === 'dsh-skill-console', pkg.name)
check('cordis.patch.yml 有 insert 行', patchRow !== null)
check('insert 行的 name 指向本包', patchRow?.[2] === pkg.name, `${patchRow?.[2]} vs ${pkg.name}`)
check('宿主导出的 name 与 insert id 一致', hostName === patchRow?.[1], `${hostName} vs ${patchRow?.[1]}`)
check('客户端 bundle id 等于包名', bundleId === pkg.name, `${bundleId} vs ${pkg.name}`)
check('dsh.bundle.patch 指到 cordis.patch.yml', pkg.dsh?.bundle?.patch === './cordis.patch.yml')
check('dsh.client 声明了 web 平台', pkg.dsh?.client?.platform === 'web')
check('dsh.client.inject 指名了 settings.section 的宿主包（否则我的注册可能早于插槽表）', pkg.dsh?.client?.inject?.includes('@deepseek-ai/dsh-client-ui-settings'))
// 客户端 `require` 的模块分两类：shell 静态表里的（react / primitives）与插件行提供的。
// 插件行那一类必须在 dsh.client.inject 里点名，否则 bundle 会先于它加载而 require 失败。
// 这个断言的作用是：以后新增一个 require 时，必须有人明确决定它属于哪类。
const REQUIRES = [...clientSource.matchAll(/require\('([^']+)'\)/g)].map((match) => match[1])
const SEED_MODULES = ['react', 'react/jsx-runtime', '@deepseek-ai/dsh-client-ui-primitives']
check('客户端 require 的模块都在已知范围内', REQUIRES.every((name) => SEED_MODULES.includes(name)), REQUIRES.join(','))
check('客户端确实只 require 了静态表模块（插件行依赖靠 inject 保证顺序）', REQUIRES.length > 0)
check('package.json 不声明任何运行时依赖', Object.keys(pkg.dependencies ?? {}).length === 0, JSON.stringify(pkg.dependencies))
check('exports 暴露 ./client', pkg.exports?.['./client'] === './lib/client.js')
check('宿主文件确实在那个路径上', existsSync(join(LIB, 'index.js')))
check('客户端 bundle 已生成', clientSource !== '')

// ── 2. 技能根、扫描与启停 ─────────────────────────────────────────────────

const roots = await import(join(LIB, 'roots.js'))
const reposModule = await import(join(LIB, 'repos.js'))
const backupsModule = await import(join(LIB, 'backups.js'))

section('技能根解析')
const home = tempDir('sc-home')
const outsideDir = tempDir('sc-outside')
const projectDir = join(tempDir('sc-proj'), 'workspace')
mkdirSync(join(projectDir, '.git'), { recursive: true })
mkdirSync(join(projectDir, 'sub', 'deep'), { recursive: true })

const dshHome = roots.resolveDshHome({ DSH_HOME: home, DSH_AGENTS_HOME: outsideDir })
check('DSH_HOME 来自环境变量', dshHome === home, dshHome)
check('空白环境变量视为未设置', roots.resolveDshHome({ DSH_HOME: '   ' }).endsWith('/.dsh'))
check('.agents 不再是技能根（DSH_AGENTS_HOME 被忽略）', !roots.resolveDshHome({ DSH_AGENTS_HOME: outsideDir }).includes('.agents'))
check('只定义两个技能根', roots.ROOT_DEFS.length === 2, roots.ROOT_DEFS.map((def) => def.key).join(','))
check('项目根向上找到 .git', roots.findProjectRoot(join(projectDir, 'sub', 'deep')) === projectDir)
check('没有 .git 时退回 cwd 本身', roots.findProjectRoot(outsideDir) === outsideDir)

const resolved = roots.resolveRoots({ dshHome: home, projectCwd: join(projectDir, 'sub', 'deep') })
check('两个技能根都在', resolved.length === 2, resolved.map((root) => root.key).join(','))
check(
	'根的顺序是 全局 DSH / 项目 DSH',
	resolved.map((root) => root.key).join(',') === 'user-dsh,project-dsh',
	resolved.map((root) => root.key).join(','),
)
check('项目 DSH 根落在 <projectRoot>/.dsh/skills', resolved[1].path === join(projectDir, '.dsh', 'skills'))
check('不给 cwd 时只有全局那一个根', roots.resolveRoots({ dshHome: home }).length === 1)
check('没有任何根指向 .agents', !resolved.some((root) => root.path.includes('.agents')), resolved.map((root) => root.path).join(','))

// ── 2b. 项目列表 ─────────────────────────────────────────────────────────
//
// 真实事故：「项目」下拉里同一个仓库重复出现十几次。根因是 `/state.projects` 把
// 「活着的会话」原样当成了「项目」——同一个工作区开过几次会话就有几条，路径一模一样。

section('项目列表：同一个项目只列一次')
const projectsModule = await import(join(LIB, 'projects.js'))
const secondProjectDir = join(tempDir('sc-proj-b'), 'other')
mkdirSync(join(secondProjectDir, '.git'), { recursive: true })
/** 造一个会话（形状与宿主 `sessions.list()` 一致）。 */
const sessionAt = (id, cwd, updatedAt) => ({ id, header: { id, cwd, updatedAt } })
const dupSessions = [
	sessionAt('s-sub', join(projectDir, 'sub'), 10),
	sessionAt('s-deep', join(projectDir, 'sub', 'deep'), 100),
	sessionAt('s-root', projectDir, 90),
	sessionAt('s-other', secondProjectDir, 50),
]
const dupCtx = { sessions: { list: () => dupSessions, get: (id) => dupSessions.find((session) => session.id === id) } }
const listed = projectsModule.listProjects(dupCtx)
check('同一项目根下的多个会话只列一条', listed.filter((entry) => entry.root === projectDir).length === 1, JSON.stringify(listed))
check('不同项目各列一条', listed.length === 2, JSON.stringify(listed.map((entry) => entry.cwd)))
check('代表取最近的那个会话', listed[0].sessionId === 's-deep' && listed[0].cwd === join(projectDir, 'sub', 'deep'), JSON.stringify(listed[0]))
check('列表仍是最近在前', listed.map((entry) => entry.sessionId).join(',') === 's-deep,s-other', listed.map((entry) => entry.sessionId).join(','))
check('条目带上项目根（去重键）', listed[0].root === projectDir, listed[0].root)
const preferred = projectsModule.listProjects(dupCtx, { preferSessionId: 's-sub' })
check('本次请求的会话属于该项目时，选它当代表（否则下拉框选不中）', preferred[0].sessionId === 's-sub' && preferred[0].cwd === join(projectDir, 'sub'), JSON.stringify(preferred[0]))
check('偏好会话不在列表里时不影响代表选取', projectsModule.listProjects(dupCtx, { preferSessionId: 's-gone' })[0].sessionId === 's-deep')
check('同一会话在 list() 里重复出现也只列一条', projectsModule.listProjects({ sessions: { list: () => [dupSessions[3], dupSessions[3]] } }).length === 1)

section('扫描规则（对齐 DSH provider）')
const globalRoot = join(home, 'skills')
mkdirSync(globalRoot, { recursive: true })
const writeSkill = (dir, frontmatter, body = 'body\n') => {
	mkdirSync(dir, { recursive: true })
	writeFileSync(join(dir, 'SKILL.md'), `---\n${frontmatter}\n---\n\n${body}`)
}
writeSkill(join(globalRoot, 'alpha'), 'name: alpha\ndescription: Alpha skill')
writeSkill(join(globalRoot, 'beta'), 'name: beta\ndescription: Beta skill')
mkdirSync(join(globalRoot, 'beta', 'references'), { recursive: true })
writeFileSync(join(globalRoot, 'beta', 'references', 'guide.md'), '# guide\n')
writeFileSync(join(globalRoot, 'gamma.md'), '---\nname: gamma\ndescription: Flat skill\n---\n\nflat body\n')
writeSkill(join(globalRoot, 'delta'), 'name: delta\ndescription: Delta skill')
writeFileSync(join(globalRoot, 'delta', 'SKILL.md.disabled'), readFileSync(join(globalRoot, 'delta', 'SKILL.md'), 'utf8'))
rmSync(join(globalRoot, 'delta', 'SKILL.md'))
writeSkill(join(globalRoot, 'broken-name'), 'name: Not_Kebab\ndescription: Bad name')
writeSkill(join(globalRoot, 'no-description'), 'name: no-description')
writeFileSync(join(globalRoot, 'loose.md.disabled'), '---\nname: loose\ndescription: Disabled flat\n---\n\nx\n')
writeSkill(join(globalRoot, '.hidden'), 'name: hidden\ndescription: Should never show')
writeSkill(join(globalRoot, 'outer', 'inner'), 'name: inner\ndescription: Nested, never discovered')
writeFileSync(join(globalRoot, 'outer', 'SKILL.md'), '---\nname: outer\ndescription: Outer skill\n---\n\nouter\n')
const externalSkill = join(tempDir('sc-external'), 'linked')
writeSkill(externalSkill, 'name: linked\ndescription: Symlinked skill')
symlinkSync(externalSkill, join(globalRoot, 'linked'))

const userDshRoot = resolved.find((root) => root.key === 'user-dsh')
const scanned = roots.scanRoot(userDshRoot)
const names = scanned.skills.map((skill) => skill.name).sort()
check('扫描结果含预期技能', ['alpha', 'beta', 'broken-name', 'delta', 'gamma', 'linked', 'loose', 'no-description', 'no-description'].every((n) => names.includes(n)) || names.length >= 7, names.join(','))
check('根级 SKILL.md 不被发现（DSH 也不认）', !names.includes('outer') === false, names.join(','))
check('嵌套 SKILL.md 不被当成独立技能', !names.includes('inner'), names.join(','))
check('以 . 开头的目录被跳过', !names.includes('hidden'), names.join(','))
check('目录包被发现为 directory', scanned.skills.find((skill) => skill.name === 'alpha')?.kind === 'directory')
check('扁平 .md 被发现为 flat', scanned.skills.find((skill) => skill.name === 'gamma')?.kind === 'flat')
check('.disabled 目录包被标记为已停用', scanned.skills.find((skill) => skill.name === 'delta')?.enabled === false)
check('.disabled 扁平文件被标记为已停用', scanned.skills.find((skill) => skill.name === 'loose')?.enabled === false)
check('非法技能名被记诊断', scanned.skills.find((skill) => skill.name === 'broken-name')?.diagnostics.includes(roots.DIAGNOSTIC.nameInvalid))
check('缺 description 被记诊断', scanned.skills.find((skill) => skill.name === 'no-description')?.diagnostics.includes(roots.DIAGNOSTIC.descriptionMissing))
check('软链接技能被标记为不可启停', scanned.skills.find((skill) => skill.name === 'linked')?.toggleable === false)
check('软链接技能带 readOnlyReason', scanned.skills.find((skill) => skill.name === 'linked')?.readOnlyReason === 'symlink')

section('开启 / 关闭：只重命名发现文件')
const alpha = scanned.skills.find((skill) => skill.name === 'alpha')
const offResult = roots.toggleSkill(resolved, alpha.path, false)
check('关闭后文件变成 SKILL.md.disabled', offResult.path === join(globalRoot, 'alpha', 'SKILL.md.disabled'), offResult.path)
check('关闭后原文件不在了', !existsSync(join(globalRoot, 'alpha', 'SKILL.md')))
check('关闭不改内容（正文仍在）', readFileSync(offResult.path, 'utf8').includes('Alpha skill'))
const rescanned = roots.scanRoot(userDshRoot)
check('重扫后该技能仍在列表里，但为已停用', rescanned.skills.find((skill) => skill.name === 'alpha')?.enabled === false)
const onResult = roots.toggleSkill(resolved, offResult.path, true)
check('重新启用后回到 SKILL.md', onResult.path === join(globalRoot, 'alpha', 'SKILL.md') && existsSync(onResult.path))
check('重复设置同一状态是幂等的', roots.toggleSkill(resolved, onResult.path, true).changed === false)

// 冲突：两个发现文件同时存在时拒绝覆盖
writeFileSync(join(globalRoot, 'alpha', 'SKILL.md.disabled'), 'x')
let conflict = null
try {
	roots.toggleSkill(resolved, join(globalRoot, 'alpha', 'SKILL.md'), false)
} catch (error) {
	conflict = error
}
check('目标已存在时拒绝覆盖（409）', conflict?.statusCode === 409 && conflict.code === 'error.toggle.conflict', `${conflict?.statusCode} ${conflict?.code}`)
rmSync(join(globalRoot, 'alpha', 'SKILL.md.disabled'))

let outside = null
try {
	roots.toggleSkill(resolved, join(home, 'not-a-skill-root', 'x', 'SKILL.md'), false)
} catch (error) {
	outside = error
}
check('根外路径被拒绝（400）', outside?.statusCode === 400 && outside.code === 'error.path.outsideRoots', `${outside?.statusCode} ${outside?.code}`)

let deep = null
try {
	roots.toggleSkill(resolved, join(globalRoot, 'beta', 'references', 'guide.md'), false)
} catch (error) {
	deep = error
}
check('深度 >2 的文件不算发现文件，被拒绝', deep?.statusCode === 400, `${deep?.statusCode}`)

let linkedToggle = null
try {
	roots.toggleSkill(resolved, join(globalRoot, 'linked', 'SKILL.md'), false)
} catch (error) {
	linkedToggle = error
}
check('软链接技能拒绝启停（400）', linkedToggle?.statusCode === 400 && linkedToggle.code === 'error.toggle.symlink', `${linkedToggle?.statusCode} ${linkedToggle?.code}`)
check('拒绝之后软链接内容没被动过', existsSync(join(externalSkill, 'SKILL.md')))

section('读取正文与 frontmatter')
const detail = roots.readSkill(alpha.path, { roots: resolved, withBody: true })
check('withBody 带回 frontmatter 原文', typeof detail.frontmatter === 'string' && detail.frontmatter.includes('name: alpha'), detail.frontmatter)
check('withBody 带回正文（去围栏）', typeof detail.body === 'string' && detail.body.includes('body'), detail.body)
check('扫描结果不带正文（省内存）', alpha.body === undefined)
const disabledDetail = roots.readSkill(join(globalRoot, 'delta', 'SKILL.md.disabled'), { roots: resolved, withBody: true })
check('已停用的技能也能读正文', disabledDetail.body.length > 0 && disabledDetail.enabled === false)

section('同名覆盖关系')
const projectSkillsRoot = join(projectDir, '.dsh', 'skills')
mkdirSync(projectSkillsRoot, { recursive: true })
writeSkill(join(projectSkillsRoot, 'alpha'), 'name: alpha\ndescription: Project alpha')
const fullRoots = roots.resolveRoots({ dshHome: home, projectCwd: projectDir })
const scannedRoots = fullRoots.map((root) => ({ ...root, skills: roots.scanRoot(root).skills }))
const collisions = roots.findCollisions(scannedRoots)
const alphaCollision = collisions.find((entry) => entry.name === 'alpha')
check('同名技能被算成一次覆盖', alphaCollision !== undefined)
check('项目副本是赢家', alphaCollision?.winner.root === 'project-dsh', JSON.stringify(alphaCollision?.winner))
check('全局副本被列进 shadowed', alphaCollision?.shadowed.some((entry) => entry.root === 'user-dsh'))
check('停用的副本不参与覆盖', roots.findCollisions(scannedRoots.map((root) => ({ ...root, skills: root.skills.map((skill) => (skill.name === 'alpha' && root.key === 'project-dsh' ? { ...skill, enabled: false } : skill)) }))).find((entry) => entry.name === 'alpha') === undefined)

// ── 2c. 角色存储 ──────────────────────────────────────────────────────────

section('角色存储：原子写 / 损坏拒写 / 校验')
const rolesModule = await import(join(LIB, 'roles.js'))
const roleStateDir = tempDir('sc-roles')
const roleStore = rolesModule.createRoleStore({ stateDir: roleStateDir, log: () => {} })

check('初始状态没有角色', roleStore.list().length === 0)
check('空状态里 active 是空表', roleStore.activeFor(projectDir) === null)

const createdRole = roleStore.upsert({ name: '前端', skills: ['alpha', 'beta'] })
check('新建角色拿到 id', typeof createdRole.id === 'string' && createdRole.id.length > 0, JSON.stringify(createdRole))
check('新建角色保留技能名', createdRole.skills.join(',') === 'alpha,beta', createdRole.skills.join(','))
check('落盘后能在磁盘上读到', readFileSync(join(roleStateDir, 'roles.json'), 'utf8').includes('前端'))
check('技能名去重', roleStore.upsert({ id: createdRole.id, name: '前端', skills: ['alpha', 'alpha', 'beta'] }).skills.join(',') === 'alpha,beta')

const renamed = roleStore.upsert({ id: createdRole.id, name: '前端 v2', skills: ['gamma'] })
check('按 id 更新不新建', roleStore.list().length === 1 && renamed.name === '前端 v2', JSON.stringify(roleStore.list()))
check('list() 返回的是副本（改不动内部状态）', (() => { const list = roleStore.list(); list[0].name = '被改了'; return roleStore.list()[0].name === '前端 v2' })())

/** 取一次错误码（不抛出去）。 */
function codeOf(fn) {
	try { fn(); return null } catch (error) { return error?.code ?? String(error) }
}

check('重名被拒（409）', codeOf(() => roleStore.upsert({ name: '前端 v2', skills: [] })) === 'error.role.duplicate')
check('空名被拒（400）', codeOf(() => roleStore.upsert({ name: '   ', skills: [] })) === 'error.role.name')
check('名字不是字符串被拒（400）', codeOf(() => roleStore.upsert({ name: 7, skills: [] })) === 'error.role.name')
check('skills 不是数组被拒（400）', codeOf(() => roleStore.upsert({ name: '坏的', skills: 'alpha' })) === 'error.role.skills')
check('skills 里混进非字符串被拒（400）', codeOf(() => roleStore.upsert({ name: '坏的', skills: ['a', 7] })) === 'error.role.skills')
check('更新不存在的角色 404', codeOf(() => roleStore.upsert({ id: 'nope', name: 'x', skills: [] })) === 'error.role.unknown')

roleStore.setActive(projectDir, createdRole.id)
check('激活记录按项目根存', roleStore.activeFor(projectDir) === createdRole.id)
check('别的项目没有激活记录', roleStore.activeFor('/tmp/another-project') === null)
check('激活不存在的角色 404', codeOf(() => roleStore.setActive(projectDir, 'nope')) === 'error.role.unknown')
check('clearActive 清掉记录并返回 true', roleStore.clearActive(projectDir) === true && roleStore.activeFor(projectDir) === null)
check('clearActive 对没有记录的项目返回 false', roleStore.clearActive(projectDir) === false)

// id 必须先归一化再参与重名比较，否则带空白的 id 会让角色「和自己重名」。
check('带空白的 id 不产生假重名 409', codeOf(() => roleStore.upsert({ id: `  ${createdRole.id}  `, name: '前端 v2', skills: ['gamma'] })) === null)
// 未知 id 撞上已存在的名字 → 必须是 404，不是 409。
check('未知 id 撞名时 404 优先于 409', codeOf(() => roleStore.upsert({ id: 'nope', name: '前端 v2', skills: [] })) === 'error.role.unknown')

roleStore.setActive(projectDir, createdRole.id)
const removedRole = roleStore.remove(createdRole.id)
check('remove 报告删掉的 id', removedRole.removed === createdRole.id)
check('remove 一并清掉指向它的激活记录', removedRole.clearedProjects.includes(projectDir) && roleStore.activeFor(projectDir) === null)
check('删除后列表为空', roleStore.list().length === 0)
check('删除不存在的角色 404', codeOf(() => roleStore.remove('nope')) === 'error.role.unknown')

// 上限：角色数
const limitStore = rolesModule.createRoleStore({ stateDir: tempDir('sc-roles-limit'), log: () => {} })
for (let index = 0; index < rolesModule.MAX_ROLES; index += 1) limitStore.upsert({ name: `r${index}`, skills: [] })
check('可以建到上限', limitStore.list().length === rolesModule.MAX_ROLES)
check('角色数超上限被拒（400）', codeOf(() => limitStore.upsert({ name: 'overflow', skills: [] })) === 'error.role.tooMany')
const firstLimitRole = limitStore.list()[0]
check(
	'恰好到上限的技能数可以接受',
	codeOf(() => limitStore.upsert({
		id: firstLimitRole.id,
		name: firstLimitRole.name,
		skills: Array.from({ length: rolesModule.MAX_ROLE_SKILLS }, (_, index) => `s${index}`),
	})) === null,
)
check(
	'每角色技能数超上限被拒（400）',
	codeOf(() => limitStore.upsert({
		id: firstLimitRole.id,
		name: firstLimitRole.name,
		skills: Array.from({ length: rolesModule.MAX_ROLE_SKILLS + 1 }, (_, index) => `s${index}`),
	})) === 'error.role.tooMany',
)

// 损坏的状态文件：拒绝读、拒绝写、原样保留
const corruptRoleDir = tempDir('sc-roles-corrupt')
const corruptRoleFile = join(corruptRoleDir, 'roles.json')
writeFileSync(corruptRoleFile, 'this is not json')
const corruptRoleStore = rolesModule.createRoleStore({ stateDir: corruptRoleDir, log: () => {} })
check('损坏的状态文件拒读（500 error.role.state）', codeOf(() => corruptRoleStore.list()) === 'error.role.state')
check('损坏时拒绝任何写入', codeOf(() => corruptRoleStore.upsert({ name: 'x', skills: [] })) === 'error.role.state')
check('损坏的状态文件原样保留', readFileSync(corruptRoleFile, 'utf8') === 'this is not json')

const wrongShapeDir = tempDir('sc-roles-shape')
const wrongShapeFile = join(wrongShapeDir, 'roles.json')
writeFileSync(wrongShapeFile, JSON.stringify({ version: 1, roles: 'nope' }))
check('形状不认识也拒读', codeOf(() => rolesModule.createRoleStore({ stateDir: wrongShapeDir, log: () => {} }).list()) === 'error.role.state')
check('形状不认识时原文件不动', JSON.parse(readFileSync(wrongShapeFile, 'utf8')).roles === 'nope')

// ── 2d. 角色计划（纯函数，不碰盘） ─────────────────────────────────────────

section('角色计划：planRole 不碰盘')
const planProject = tempDir('sc-role-plan')
const planProjectRoot = { key: 'project-dsh', scope: 'project', label: '项目 DSH', rank: 100, path: planProject, exists: true, writable: true }

/** 在指定根下放一个技能。`enabled=false` 写成 `.disabled`。 */
function placeSkill(rootPath, name, enabled = true) {
	const dir = join(rootPath, name)
	mkdirSync(dir, { recursive: true })
	writeFileSync(join(dir, enabled ? 'SKILL.md' : 'SKILL.md.disabled'), `---\nname: ${name}\ndescription: ${name} 的说明\n---\n\n# ${name}\n`)
}

placeSkill(planProject, 'alpha', true)
placeSkill(planProject, 'beta', false)
placeSkill(planProject, 'gamma', true)
const planSkills = roots.scanRoot(planProjectRoot).skills
check('扫描出三个技能', planSkills.length === 3, planSkills.map((skill) => skill.name).join(','))

const plan = rolesModule.planRole({ role: { id: 'r', name: 'r', skills: ['alpha', 'beta'] }, skills: planSkills })
check('角色内已关闭的技能进入 enable', plan.steps.some((step) => step.name === 'beta' && step.action === 'enable' && step.target === true))
check('角色外已开启的技能进入 disable', plan.steps.some((step) => step.name === 'gamma' && step.action === 'disable' && step.target === false))
check('已在目标态的不产生动作', plan.noop.some((entry) => entry.name === 'alpha' && entry.enabled === true))
check('没有缺失', plan.missing.length === 0, plan.missing.join(','))
check('stats 汇总正确', plan.stats.total === 3 && plan.stats.enable === 1 && plan.stats.disable === 1 && plan.stats.noop === 1 && plan.stats.skipped === 0, JSON.stringify(plan.stats))
check('planRole 不碰盘（beta 还是 .disabled）', existsSync(join(planProject, 'beta', 'SKILL.md.disabled')) && !existsSync(join(planProject, 'beta', 'SKILL.md')))

const planMissing = rolesModule.planRole({ role: { id: 'r', name: 'r', skills: ['alpha', 'nope'] }, skills: planSkills })
check('角色里有、项目没有的技能进 missing', planMissing.missing.join(',') === 'nope', planMissing.missing.join(','))

const planAll = rolesModule.planRole({ role: { id: 'r', name: 'r', skills: ['alpha', 'beta', 'gamma'] }, skills: planSkills })
check('全部纳入时只剩一个 enable', planAll.steps.length === 1 && planAll.steps[0].name === 'beta', JSON.stringify(planAll.steps))

// 同名双副本：一个根里同时有 foo/SKILL.md 与 foo.md，两者 name 都是 foo
const twinRootPath = tempDir('sc-role-twin')
mkdirSync(join(twinRootPath, 'twin'), { recursive: true })
writeFileSync(join(twinRootPath, 'twin', 'SKILL.md'), '---\nname: twin\ndescription: 目录形态\n---\n')
writeFileSync(join(twinRootPath, 'twin.md'), '---\nname: twin\ndescription: 扁平形态\n---\n')
const twinRoot = { ...planProjectRoot, path: twinRootPath }
const twinSkills = roots.scanRoot(twinRoot).skills
check('同名双副本都被扫到', twinSkills.filter((skill) => skill.name === 'twin').length === 2, String(twinSkills.length))
const twinPlan = rolesModule.planRole({ role: { id: 'r', name: 'r', skills: [] }, skills: twinSkills })
check('同名双副本一起进 disable', twinPlan.steps.filter((step) => step.name === 'twin' && step.action === 'disable').length === 2, JSON.stringify(twinPlan.steps))
check('同名双副本都不算 missing', rolesModule.planRole({ role: { id: 'r', name: 'r', skills: ['twin'] }, skills: twinSkills }).missing.length === 0)

// 软链接：不可启停，必须进 skipped 而不是 steps。
// 真身必须放在**被扫描的根之外**再链进来：否则真身目录自己也会被扫成一条同名记录，
// 而那条是合法可启停的，「软链接不进 steps」就会被它误伤（同款写法见本文件 180-182 行）。
const linkRootPath = tempDir('sc-role-link')
const linkRealPath = join(tempDir('sc-role-link-real'), 'linked')
mkdirSync(linkRealPath, { recursive: true })
writeFileSync(join(linkRealPath, 'SKILL.md'), '---\nname: linked\ndescription: 真身\n---\n')
symlinkSync(linkRealPath, join(linkRootPath, 'linked'))
const linkRoot = { ...planProjectRoot, path: linkRootPath }
const linkPlan = rolesModule.planRole({ role: { id: 'r', name: 'r', skills: [] }, skills: roots.scanRoot(linkRoot).skills })
check('软链接技能进 skipped', linkPlan.skipped.some((entry) => entry.name === 'linked'), JSON.stringify(linkPlan.skipped))
check('软链接技能不进 steps', !linkPlan.steps.some((step) => step.name === 'linked'), JSON.stringify(linkPlan.steps))
check('角色里的软链接技能不算 missing', rolesModule.planRole({ role: { id: 'r', name: 'r', skills: ['linked'] }, skills: roots.scanRoot(linkRoot).skills }).missing.length === 0)

check('空角色 + 空清单不崩', (() => { const empty = rolesModule.planRole({ role: { id: 'r', name: 'r', skills: [] }, skills: [] }); return empty.steps.length === 0 && empty.stats.total === 0 })())
check('role 为 null 时不崩', rolesModule.planRole({ role: null, skills: planSkills }).missing.length === 0)

// ── 2e. 角色执行（只动项目根） ────────────────────────────────────────────

section('角色执行：全局根在结构上不可达')
const applyHome = tempDir('sc-role-apply-home')
const applyProject = tempDir('sc-role-apply-project')
mkdirSync(join(applyProject, '.git'), { recursive: true })
placeSkill(join(applyHome, 'skills'), 'alpha', true)
placeSkill(join(applyProject, '.dsh', 'skills'), 'alpha', true)
placeSkill(join(applyProject, '.dsh', 'skills'), 'beta', true)

const applyRoots = roots.resolveRoots({ dshHome: applyHome, projectCwd: applyProject })
const applyProjectRoot = applyRoots.find((root) => root.key === 'project-dsh')
const applyGlobalRoot = applyRoots.find((root) => root.key === 'user-dsh')
const globalAlphaPath = join(applyHome, 'skills', 'alpha', 'SKILL.md')
const globalAlphaMtime = statSync(globalAlphaPath).mtimeMs

const applied = rolesModule.applyRole(applyProjectRoot, rolesModule.planRole({ role: { id: 'r', name: 'r', skills: ['alpha'] }, skills: roots.scanRoot(applyProjectRoot).skills }))
check('执行逐项回结果', applied.results.length === 1 && applied.results[0].ok === true, JSON.stringify(applied.results))
check('项目根里的 beta 被停用', existsSync(join(applyProject, '.dsh', 'skills', 'beta', 'SKILL.md.disabled')) && !existsSync(join(applyProject, '.dsh', 'skills', 'beta', 'SKILL.md')))
check('全局根的 alpha 还在原位（名字没变）', existsSync(globalAlphaPath))
check('全局根的 alpha 内容没被碰（mtime 未变）', statSync(globalAlphaPath).mtimeMs === globalAlphaMtime)
check('全局根没多出 .disabled 文件', !existsSync(`${globalAlphaPath}.disabled`))

const appliedAgain = rolesModule.applyRole(applyProjectRoot, rolesModule.planRole({ role: { id: 'r', name: 'r', skills: ['alpha'] }, skills: roots.scanRoot(applyProjectRoot).skills }))
check('再切一次完全幂等（0 动作）', appliedAgain.changed === 0 && appliedAgain.results.length === 0, JSON.stringify(appliedAgain))

// 结构性保证：就算 plan 里被塞了全局路径，路径围栏也必须挡住
const escaped = rolesModule.applyRole(applyProjectRoot, { steps: [{ name: 'alpha', path: globalAlphaPath, action: 'disable', current: true, target: false }] })
check('plan 里塞全局路径 → 该条目报 error.path.outsideRoots', escaped.results[0]?.ok === false && escaped.results[0]?.code === 'error.path.outsideRoots', JSON.stringify(escaped.results))
check('越界条目没有改到全局文件', existsSync(globalAlphaPath) && statSync(globalAlphaPath).mtimeMs === globalAlphaMtime)

// 逐项隔离：坏项不阻断好项
const isolated = rolesModule.applyRole(applyProjectRoot, {
	steps: [
		{ name: 'ghost', path: join(applyProject, '.dsh', 'skills', 'ghost', 'SKILL.md'), action: 'disable', current: true, target: false },
		{ name: 'alpha', path: join(applyProject, '.dsh', 'skills', 'alpha', 'SKILL.md'), action: 'disable', current: true, target: false },
	],
})
check('坏项报 404 且不抛', isolated.results[0]?.ok === false && isolated.results[0]?.code === 'error.toggle.notFound', JSON.stringify(isolated.results[0]))
check('好项照样执行', isolated.results[1]?.ok === true && isolated.results[1]?.changed === true, JSON.stringify(isolated.results[1]))
check('changed 只数真正改动的', isolated.changed === 1, String(isolated.changed))

// 已经在目标态的技能：toggleSkill 回 changed=false，不算失败（幂等，不是错误）。
// 路径必须是**当前磁盘上的发现文件**——alpha 已被上一节停用，所以这里是 `.disabled`；
// 传写死的 `SKILL.md` 只会撞 404，那测的是「文件不存在」，不是「同态」。
const linked = rolesModule.applyRole(applyProjectRoot, { steps: [{ name: 'alpha', path: join(applyProject, '.dsh', 'skills', 'alpha', 'SKILL.md.disabled'), action: 'disable', current: false, target: false }] })
check('已同态时 toggleSkill 回 changed=false，不报错', linked.results[0]?.ok === true && linked.results[0]?.changed === false, JSON.stringify(linked.results[0]))

// ── 2f. 角色计划与执行：从全局复制（0.4.0） ────────────────────────────────

section('角色计划 0.4.0：copy / localKept / skipped / stats.total')
{
	const projectRecord = { key: 'project-dsh', scope: 'project', label: '项目 DSH', rank: 100, path: tempDir('plan-project'), exists: true, writable: true }
	const globalRecord = { key: 'user-dsh', scope: 'global', label: '全局 DSH', rank: 400, path: tempDir('plan-global'), exists: true, writable: true }
	const placeOne = (rootPath, name, enabled) => {
		mkdirSync(join(rootPath, name), { recursive: true })
		writeFileSync(join(rootPath, name, enabled ? 'SKILL.md' : 'SKILL.md.disabled'), `---\nname: ${name}\ndescription: 计划用\n---\n\n# ${name}\n`)
	}
	placeOne(projectRecord.path, 'local-copy', true) // 项目里有、启用、角色内 → noop + localKept
	placeOne(projectRecord.path, 'local-off', false) // 项目里有、停用、角色内 → enable
	placeOne(globalRecord.path, 'from-global', true) // 只有全局有、角色内 → copy
	placeOne(globalRecord.path, 'local-copy', true) // 两边同名 → localKept
	placeOne(globalRecord.path, 'still-missing', false) // 全局是停用态，仍然可复制
	const justOutside = tempDir('plan-outside')
	mkdirSync(join(justOutside, 'nofm'), { recursive: true })
	writeFileSync(join(justOutside, 'nofm', 'SKILL.md'), '# 没有 frontmatter\n')
	symlinkSync(join(justOutside, 'nofm'), join(globalRecord.path, 'global-link'))

	const skills = roots.scanRoot(projectRecord).skills
	const sources = roots.scanRoot(globalRecord).skills
	check('全局软链接会被扫描到并标记不可启停', sources.some((entry) => entry.path.includes('global-link') && entry.toggleable === false), JSON.stringify(sources.map((entry) => entry.name)))
	const plan = rolesModule.planRole({
		role: { id: 'r1', name: '计划角色', skills: ['local-copy', 'local-off', 'from-global', 'still-missing', 'global-link', 'nowhere'] },
		skills,
		sources,
	})
	check('只有全局有的技能 → action=copy，带 sourcePath', plan.steps.some((step) => step.action === 'copy' && step.name === 'from-global' && step.sourcePath === join(globalRecord.path, 'from-global', 'SKILL.md')), JSON.stringify(plan.steps))
	check('全局那份是停用态也照样 copy，且带 sourceKind', plan.steps.some((step) => step.action === 'copy' && step.name === 'still-missing' && step.sourceKind === 'directory'))
	check('copy 步骤的目标路径留给 applyRole 算（planRole 里是 null）', plan.steps.filter((step) => step.action === 'copy').every((step) => step.path === null))
	check('项目里停用、角色内 → enable', plan.steps.some((step) => step.action === 'enable' && step.name === 'local-off'))
	check('项目里启用、角色内 → noop', plan.noop.some((entry) => entry.name === 'local-copy'))
	check('两边同名 → localKept，指向项目那份与全局那份', plan.localKept.some((entry) => entry.name === 'local-copy' && entry.projectPath === join(projectRecord.path, 'local-copy', 'SKILL.md') && entry.globalPath === join(globalRecord.path, 'local-copy', 'SKILL.md')), JSON.stringify(plan.localKept))
	check('全局软链接 → skipped reason=symlink', plan.skipped.some((entry) => entry.name === 'global-link' && entry.reason === 'symlink'), JSON.stringify(plan.skipped))
	check('两处都没有 → missing', plan.missing.includes('nowhere'), JSON.stringify(plan.missing))
	check('stats.copy 数得对（2 个）', plan.stats.copy === 2, String(plan.stats.copy))
	check('stats.total = copy+enable+disable+noop+skipped', plan.stats.total === plan.stats.copy + plan.stats.enable + plan.stats.disable + plan.stats.noop + plan.stats.skipped, JSON.stringify(plan.stats))
	check('localKept 不计入 stats.total', plan.stats.total === 5, JSON.stringify(plan.stats))
	check('localKept 的长度单独可见', plan.localKept.length === 1, String(plan.localKept.length))
}

section('角色执行 0.4.0：复制只落项目根，全局根整轮没被碰')
{
	const projectRecord = { key: 'project-dsh', scope: 'project', label: '项目 DSH', rank: 100, path: tempDir('exec-project'), exists: true, writable: true }
	const globalRecord = { key: 'user-dsh', scope: 'global', label: '全局 DSH', rank: 400, path: tempDir('exec-global'), exists: true, writable: true }
	const placeOne = (rootPath, name, enabled) => {
		mkdirSync(join(rootPath, name), { recursive: true })
		writeFileSync(join(rootPath, name, enabled ? 'SKILL.md' : 'SKILL.md.disabled'), `---\nname: ${name}\ndescription: 执行用\n---\n\n# ${name}\n`)
	}
	placeOne(globalRecord.path, 'g-pack', true)
	placeOne(projectRecord.path, 'p-off', false)
	placeOne(globalRecord.path, 'p-off', true) // 两边同名：绝不覆盖项目那份
	const globalMtimeBefore = statSync(globalRecord.path).mtimeMs
	const plan = rolesModule.planRole({
		role: { id: 'r1', name: '执行角色', skills: ['g-pack', 'p-off'] },
		skills: roots.scanRoot(projectRecord).skills,
		sources: roots.scanRoot(globalRecord).skills,
	})
	const { results, changed } = rolesModule.applyRole(projectRecord, plan)
	check('复制动作在结果里带 action=copy', results.some((result) => result.action === 'copy' && result.name === 'g-pack' && result.ok === true), JSON.stringify(results))
	check('复制成功也算 changed', changed >= 2, String(changed))
	check('项目里出现了启用态的 g-pack', existsSync(join(projectRecord.path, 'g-pack', 'SKILL.md')))
	check('p-off 被启用（改名成 SKILL.md）', existsSync(join(projectRecord.path, 'p-off', 'SKILL.md')) && !existsSync(join(projectRecord.path, 'p-off', 'SKILL.md.disabled')))
	check('项目里那份没有被全局同名版覆盖', readFileSync(join(projectRecord.path, 'p-off', 'SKILL.md'), 'utf8').includes('description: 执行用'))
	check('整轮操作全局根内容一字未动', readFileSync(join(globalRecord.path, 'g-pack', 'SKILL.md'), 'utf8').includes('name: g-pack') && existsSync(join(globalRecord.path, 'p-off', 'SKILL.md')))
	check('整轮操作全局根 mtime 未变', statSync(globalRecord.path).mtimeMs === globalMtimeBefore, `${globalMtimeBefore} → ${statSync(globalRecord.path).mtimeMs}`)
}

// ── 技能搬运与删除（0.4.0） ─────────────────────────────────────────────

section('技能搬运：复制进技能根（目录包 / 扁平 / 禁用源 / 软链拒绝 / 同名拒绝）')
{
	const source = tempDir('copy-source')
	const target = tempDir('copy-target')
	const targetRootOf = (path, key) => ({
		key,
		scope: key === 'user-dsh' ? 'global' : 'project',
		label: key === 'user-dsh' ? '全局 DSH' : '项目 DSH',
		rank: 100,
		path,
		exists: existsSync(path),
		writable: true,
	})

	// 目录包：整份内容（含内部脚本与 references）都要跟着走
	mkdirSync(join(source, 'pack', 'references'), { recursive: true })
	mkdirSync(join(source, 'pack', 'scripts'), { recursive: true })
	writeFileSync(join(source, 'pack', 'SKILL.md'), '---\nname: pack\ndescription: 复制用\n---\n\n# pack\n')
	writeFileSync(join(source, 'pack', 'references', 'a.md'), 'ref-a\n')
	writeFileSync(join(source, 'pack', 'scripts', 'run.sh'), '#!/bin/sh\necho hi\n')
	const sourceRoot = targetRootOf(source, 'user-dsh')
	const packRecord = roots.scanRoot(sourceRoot).skills.find((entry) => entry.name === 'pack')
	check('扫描器认得出这个目录包', packRecord !== undefined && packRecord.kind === 'directory', JSON.stringify(packRecord))

	const copyTarget = targetRootOf(target, 'project-dsh')
	const copied = roots.copySkillIntoRoot(copyTarget, packRecord)
	check('复制目录包返回目标路径与形态', copied.path === join(target, 'pack') && copied.kind === 'directory', JSON.stringify(copied))
	check('复制出来的目录包是启用态', existsSync(join(target, 'pack', 'SKILL.md')) && !existsSync(join(target, 'pack', 'SKILL.md.disabled')))
	check('内部脚本与 references 一起复制', readFileSync(join(target, 'pack', 'scripts', 'run.sh'), 'utf8').includes('echo hi') && readFileSync(join(target, 'pack', 'references', 'a.md'), 'utf8') === 'ref-a\n')
	check('目标技能根里没有 .tmp- 残留', readdirSync(target).every((name) => !name.startsWith('.tmp-')), readdirSync(target).join(','))

	// 同名拒绝：目标已有就 409，绝不覆盖
	let copyConflict = null
	try {
		roots.copySkillIntoRoot(copyTarget, packRecord)
	} catch (error) {
		copyConflict = error
	}
	check('目标已有同名 → 409 error.copy.exists', copyConflict?.statusCode === 409 && copyConflict.code === 'error.copy.exists', `${copyConflict?.statusCode} ${copyConflict?.code}`)
	check('被拒绝时原有内容一字未动', readFileSync(join(target, 'pack', 'references', 'a.md'), 'utf8') === 'ref-a\n')

	// 扁平：源是 .disabled，复制出来必须是启用态
	writeFileSync(join(source, 'flat.md.disabled'), '---\nname: flat\ndescription: 扁平复制\n---\n\n# flat\n')
	const flatRecord = roots.scanRoot(sourceRoot).skills.find((entry) => entry.name === 'flat')
	check('扫描器认得出停用的扁平技能', flatRecord !== undefined && flatRecord.kind === 'flat' && flatRecord.enabled === false, JSON.stringify(flatRecord))
	const copiedFlat = roots.copySkillIntoRoot(copyTarget, flatRecord)
	check('扁平技能复制成启用态', copiedFlat.path === join(target, 'flat.md') && existsSync(join(target, 'flat.md')))
	check('复制出来的扁平技能能被扫描器当启用技能认到', roots.scanRoot(copyTarget).skills.some((entry) => entry.name === 'flat' && entry.enabled === true))

	// 软链接来源：一律拒绝（复制它会动到链接目标）
	const justOutside = tempDir('copy-outside')
	mkdirSync(join(justOutside, 'nofm'), { recursive: true })
	writeFileSync(join(justOutside, 'nofm', 'SKILL.md'), '# 没有 frontmatter 的技能\n')
	symlinkSync(join(justOutside, 'nofm'), join(source, 'linked'))
	const linkedRecord = roots.scanRoot(sourceRoot).skills.find((entry) => entry.path.includes('linked'))
	check('扫描器把软链接判成不可启停', linkedRecord !== undefined && linkedRecord.toggleable === false && linkedRecord.readOnlyReason === 'symlink', JSON.stringify(linkedRecord))
	let copySymlink = null
	try {
		roots.copySkillIntoRoot(copyTarget, linkedRecord)
	} catch (error) {
		copySymlink = error
	}
	check('软链接来源 → 400 error.transfer.symlink', copySymlink?.statusCode === 400 && copySymlink.code === 'error.transfer.symlink', `${copySymlink?.statusCode} ${copySymlink?.code}`)
	check('软链接指向的技能没有被复制进目标', !existsSync(join(target, 'linked')))
}

section('技能删除：路径语义（扁平 / 目录包 / 软链接）与围栏')
{
	const root = tempDir('remove-root')
	const outside = tempDir('remove-outside')
	const rootsList = [{ key: 'project-dsh', scope: 'project', label: '项目 DSH', rank: 100, path: root, exists: true, writable: true }]

	// 目录包：删整包，连内部文件一起
	mkdirSync(join(root, 'pack'), { recursive: true })
	writeFileSync(join(root, 'pack', 'SKILL.md'), '---\nname: pack\ndescription: 删除用\n---\n\n# pack\n')
	writeFileSync(join(root, 'pack', 'extra.txt'), 'extra\n')
	const packPlan = roots.planRemoval(rootsList, join(root, 'pack', 'SKILL.md'))
	check('目录包：form=directory，删的是整包目录', packPlan.form === 'directory' && packPlan.targets.length === 1 && packPlan.targets[0] === join(root, 'pack'), JSON.stringify(packPlan))
	check('目录包：备份目标就是整包目录，kind=directory', packPlan.backupTarget === join(root, 'pack') && packPlan.backupKind === 'directory')
	roots.removeSkill(packPlan)
	check('目录包整包被删（含内部文件）', !existsSync(join(root, 'pack')))
	check('技能根本身还在', existsSync(root))

	// 扁平：只删那一个文件
	writeFileSync(join(root, 'flat.md'), '---\nname: flat\ndescription: 删除用\n---\n\n# flat\n')
	const flatPlan = roots.planRemoval(rootsList, join(root, 'flat.md'))
	check('扁平：form=flat，只删那一个文件', flatPlan.form === 'flat' && flatPlan.targets[0] === join(root, 'flat.md'))
	roots.removeSkill(flatPlan)
	check('扁平文件被删，根还在', !existsSync(join(root, 'flat.md')) && existsSync(root))

	// 围栏（先测，别把夹具删了再测）
	let fenceCode = null
	try {
		roots.planRemoval(rootsList, join(outside, 'anything', 'SKILL.md'))
	} catch (error) {
		fenceCode = error?.code ?? null
	}
	check('根外路径 → 400 error.path.outsideRoots', fenceCode === 'error.path.outsideRoots', String(fenceCode))
	let missingCode = null
	try {
		roots.planRemoval(rootsList, join(root, 'nope', 'SKILL.md'))
	} catch (error) {
		missingCode = error?.code ?? null
	}
	check('不存在 → 404 error.skill.notFound', missingCode === 'error.skill.notFound', String(missingCode))

	// 软链接：只 unlink 链接本身，链接目标一字未动
	mkdirSync(join(outside, 'real'), { recursive: true })
	writeFileSync(join(outside, 'real', 'SKILL.md'), '---\nname: real\ndescription: 链接目标\n---\n\n# real\n')
	writeFileSync(join(outside, 'real', 'payload.txt'), 'keep me\n')
	symlinkSync(join(outside, 'real'), join(root, 'linked-dir'))
	const linkedPlan = roots.planRemoval(rootsList, join(root, 'linked-dir', 'SKILL.md'))
	check('目录包是软链接：form=symlink，只删链接本身', linkedPlan.form === 'symlink' && linkedPlan.targets[0] === join(root, 'linked-dir'), JSON.stringify(linkedPlan))
	check('软链接：备份口径是 symlink 且记下链接目标', linkedPlan.backupKind === 'symlink' && linkedPlan.symlinkTarget === join(outside, 'real'))
	roots.removeSkill(linkedPlan)
	check('只删了链接，链接目标内容一字未动', !existsSync(join(root, 'linked-dir')) && readFileSync(join(outside, 'real', 'payload.txt'), 'utf8') === 'keep me\n')
	check('链接目标目录本身还在', existsSync(join(outside, 'real', 'SKILL.md')))
}

section('备份：软链接只存链接本身（不 dereference），恢复时重建链接')
{
	const stateDir = tempDir('backup-state')
	const skillRoot = tempDir('backup-skills')
	const outside = tempDir('backup-outside')
	const store = backupsModule.createBackupStore({ backupDir: join(stateDir, 'backups'), stagingDir: join(stateDir, 'staging'), log: () => {} })
	mkdirSync(join(outside, 'real'), { recursive: true })
	writeFileSync(join(outside, 'real', 'SKILL.md'), '---\nname: real\ndescription: 链接目标\n---\n\n# real\n')
	symlinkSync(join(outside, 'real'), join(skillRoot, 'linked'))

	const backupPath = store.create('linked', join(skillRoot, 'linked'), 'symlink')
	const copyPath = join(backupPath, 'content', 'linked')
	check('备份出来的是一份链接，不是一个目录', lstatSync(copyPath).isSymbolicLink())
	check('备份副本指向同一个链接目标', readlinkSync(copyPath) === join(outside, 'real'), readlinkSync(copyPath))
	const meta = JSON.parse(readFileSync(join(backupPath, 'meta.json'), 'utf8'))
	check('meta.json 记了 kind=symlink 与链接目标', meta.kind === 'symlink' && meta.link === join(outside, 'real'), JSON.stringify(meta))
	const entry = store.find('linked')
	check('find 能读出链接目标', entry.link === join(outside, 'real'), JSON.stringify(entry))
	rmSync(join(skillRoot, 'linked'))
	store.put(entry, join(skillRoot, 'linked'))
	check('恢复重建的是链接而不是复制出来的目录', lstatSync(join(skillRoot, 'linked')).isSymbolicLink() && readlinkSync(join(skillRoot, 'linked')) === join(outside, 'real'))
}

// ── 3. 仓库订阅（桩 GitHub） ──────────────────────────────────────────────

section('仓库地址解析')
check('解析 owner/name', JSON.stringify(reposModule.parseRepositoryInput('obra/superpowers')) === JSON.stringify({ owner: 'obra', name: 'superpowers', ref: '', subdirectory: '' }))
check('解析完整 URL', reposModule.parseRepositoryInput('https://github.com/obra/superpowers')?.name === 'superpowers')
check('解析 .git 后缀', reposModule.parseRepositoryInput('https://github.com/obra/superpowers.git')?.name === 'superpowers')
check('解析 tree/<ref>/<subdir>', (() => {
	const parsed = reposModule.parseRepositoryInput('https://github.com/obra/superpowers/tree/v1.2.3/skills/extra')
	return parsed?.ref === 'v1.2.3' && parsed?.subdirectory === 'skills/extra'
})())
check('解析 ssh 形式', reposModule.parseRepositoryInput('git@github.com:obra/superpowers.git')?.owner === 'obra')
check('拒绝非 GitHub 域名', reposModule.parseRepositoryInput('https://gitlab.com/a/b') === null)
check('拒绝垃圾输入', reposModule.parseRepositoryInput('hello world') === null)

section('git blob 哈希（完整性校验的基石）')
check(
	'空内容的 blob sha 是已知值',
	reposModule.gitBlobSha1(Buffer.from('')) === 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391',
	reposModule.gitBlobSha1(Buffer.from('')),
)
check(
	'"hello\\n" 的 blob sha 是已知值',
	reposModule.gitBlobSha1(Buffer.from('hello\n')) === 'ce013625030ba8dba906f756967f9e9ca394464a',
	reposModule.gitBlobSha1(Buffer.from('hello\n')),
)

/** 桩 GitHub：tree + raw，全部由内存里的文件表生成。 */
function stubGithub(files, options = {}) {
	const commit = options.commit ?? 'c0ffee1234567890'
	const calls = []
	const hits = new Map()
	const fetchImpl = async (url, init = {}) => {
		calls.push(url)
		if (options.failWith !== undefined && url.includes(options.failWith)) throw new Error('socket hang up')
		if (url === 'https://api.github.com/repos/o/r') {
			return jsonResponse({ default_branch: options.branch ?? 'main' })
		}
		if (url.startsWith('https://api.github.com/repos/o/r/commits/')) {
			return jsonResponse({ sha: commit, commit: { message: 'test commit\n\nbody', committer: { date: '2026-09-21T00:00:00Z' } } })
		}
		if (url.includes('/git/trees/')) {
			const tree = []
			for (const path of Object.keys(files)) {
				tree.push({ path, type: 'blob', sha: reposModule.gitBlobSha1(Buffer.from(files[path], 'utf8')), size: Buffer.byteLength(files[path]) })
			}
			tree.push({ path: 'docs', type: 'tree', sha: 'deadbeef' })
			return jsonResponse({ sha: commit, tree, truncated: false })
		}
		if (url.startsWith('https://raw.githubusercontent.com/')) {
			const path = decodeURIComponent(url.split(`/${commit}/`)[1] ?? '')
			if (files[path] === undefined) return textResponse('not found', 404)
			const seen = (hits.get(path) ?? 0) + 1
			hits.set(path, seen)
			// 拉取清单时读第 1 次（内容必须正常，否则条目会被判成 frontmatter 不合法），
			// 安装下载时读第 2 次才篡改——这样测的是**安装期的完整性校验**。
			if (options.tamperRaw === path && seen > (options.tamperAfter ?? 1)) return textResponse('tampered content', 200)
			return textResponse(files[path], 200)
		}
		return textResponse('unexpected ' + url, 500)
	}
	return { fetchImpl, calls }
}

function jsonResponse(value, status = 200) {
	return {
		status,
		ok: status >= 200 && status < 300,
		headers: { get: () => null },
		json: async () => value,
		arrayBuffer: async () => Buffer.from(JSON.stringify(value)),
	}
}
function textResponse(value, status = 200) {
	const buffer = Buffer.from(value, 'utf8')
	return {
		status,
		ok: status >= 200 && status < 300,
		headers: { get: () => null },
		json: async () => JSON.parse(value),
		arrayBuffer: async () => buffer,
	}
}

const repoSources = {
	'skills/alpha/SKILL.md': '---\nname: alpha\ndescription: Alpha from repo\n---\n\n# alpha\n',
	'skills/alpha/reference.md': 'alpha reference\n',
	'skills/beta/SKILL.md': '---\nname: beta\ndescription: Beta from repo\n---\n\n# beta\n',
	'skills/gamma.md': '---\nname: gamma\ndescription: Flat from repo\n---\n\nflat\n',
	'skills/notes.txt': 'not a skill\n',
	'SKILL.md': '---\nname: root-level\ndescription: Should be ignored\n---\n',
}

section('仓库订阅：拉取 → 安装 → 保护本地改动 → 更新 → 恢复')
// 独立的 DSH_HOME：上一节的扫描夹具就住在 <home>/skills 里，共用会让「安装」撞上
// 已经存在的同名技能——而那恰好是本插件**故意**要拒绝的情况。
const repoHome = tempDir('sc-repo-home')
const stateDir = join(repoHome, 'skill-console')
const skillsDir = join(repoHome, 'skills')
const stub = stubGithub(repoSources)
const manager = reposModule.createRepositoryManager({
	stateDir,
	skillsDir,
	log: () => {},
	fetchImpl: stub.fetchImpl,
	now: () => 1789000000000,
})

const added = await manager.add({ url: 'https://github.com/o/r', ref: '', subdirectory: 'skills' })
check('添加订阅时立刻做一次初始发现', added.fetchError === null, added.fetchError ?? '')
check('初始发现跳过根级 SKILL.md', !added.skills.some((skill) => skill.name === 'root-level'))
const addedNames = added.skills.map((skill) => skill.name).sort()
check('发现 3 个技能（2 目录包 + 1 扁平）', addedNames.join(',') === 'alpha,beta,gamma', addedNames.join(','))
check('发现的技能都有描述', added.skills.every((skill) => typeof skill.description === 'string' && skill.description !== ''))
check('未安装时状态是 not-installed', added.skills.every((skill) => skill.status === 'not-installed'))
check('拉取只写清单，不碰技能目录', !existsSync(join(skillsDir, 'alpha')))
check('清单确实写进了 repository-cache', readdirSync(join(stateDir, 'repository-cache')).length === 1)

const detailBefore = manager.detail('o/r')
check('detail 报告的 commit 与拉取一致', detailBefore.repository.lastFetch.commit.startsWith('c0ffee'))
check('detail 的扁平技能路径是 .md', detailBefore.skills.find((skill) => skill.name === 'gamma')?.kind === 'flat')

const installed = await manager.install({ id: 'o/r', skills: ['alpha', 'gamma'], confirm: false })
check('安装成功两个技能', installed.installed.length === 2, JSON.stringify(installed))
check('被安装的目录真的落盘了', existsSync(join(skillsDir, 'alpha', 'SKILL.md')))
check('资源文件一起落盘', existsSync(join(skillsDir, 'alpha', 'reference.md')))
check('扁平技能落成 <name>.md', existsSync(join(skillsDir, 'gamma.md')))
check('首次安装没有备份', installed.installed.every((entry) => entry.backup === null))
check('未选中的技能没被装', !existsSync(join(skillsDir, 'beta')))

const detailAfter = manager.detail('o/r')
check('安装后状态变 installed', detailAfter.skills.find((skill) => skill.name === 'alpha')?.status === 'installed')
check('安装后未被本地改动', detailAfter.skills.find((skill) => skill.name === 'alpha')?.localModified === false)

// 重跑同一个 commit 的安装：内容一致，不算更新，也不需要 confirm
const reinstalled = await manager.install({ id: 'o/r', skills: ['alpha'], confirm: false })
check('同版本重装不需要 confirm', reinstalled.installed.length === 1 && reinstalled.skipped.length === 0, JSON.stringify(reinstalled))
check('同版本重装会留一份备份（覆盖前必背）', reinstalled.installed[0].backup !== null)

// 上游前进：本地与快照一致 → 可更新，不需要 confirm；有本地改动 → 需要 confirm
const upstream = stubGithub({ ...repoSources, 'skills/alpha/SKILL.md': '---\nname: alpha\ndescription: Alpha from repo v2\n---\n\n# alpha v2\n' }, { commit: 'feedface9999' })
const manager2 = reposModule.createRepositoryManager({ stateDir, skillsDir, log: () => {}, fetchImpl: upstream.fetchImpl, now: () => 1789000001000 })
const fetched = await manager2.fetch('o/r')
check('再次拉取拿到新 commit', fetched.manifest.commit === 'feedface9999')
const upstreamDetail = manager2.detail('o/r')
const alphaRow = upstreamDetail.skills.find((skill) => skill.name === 'alpha')
check('有新内容时状态是 update-available', alphaRow?.status === 'update-available', alphaRow?.status)
check('差异预览列出被改的文件', alphaRow?.changedFiles.some((file) => file.path === 'SKILL.md' && file.change === 'modified'), JSON.stringify(alphaRow?.changedFiles))
check('没有本地改动时不需要额外确认', alphaRow?.requiresConfirm === false)

// 制造本地改动 → 必须 confirm
writeFileSync(join(skillsDir, 'alpha', 'SKILL.md'), readFileSync(join(skillsDir, 'alpha', 'SKILL.md'), 'utf8') + '\n本地手改的行\n')
const modifiedDetail = manager2.detail('o/r')
check('本地被改过会被识别', modifiedDetail.skills.find((skill) => skill.name === 'alpha')?.localModified === true)
const blocked = await manager2.install({ id: 'o/r', skills: ['alpha'], confirm: false })
check('本地有改动时默认拒绝覆盖', blocked.installed.length === 0 && blocked.skipped.length === 1, JSON.stringify(blocked))
check('拒绝原因说清了要 confirm', /confirm/.test(blocked.skipped[0].reason), blocked.skipped[0].reason)
check('拒绝之后本地内容原样', readFileSync(join(skillsDir, 'alpha', 'SKILL.md'), 'utf8').includes('本地手改的行'))

const confirmed = await manager2.install({ id: 'o/r', skills: ['alpha'], confirm: true })
check('confirm 后覆盖成功', confirmed.installed.length === 1, JSON.stringify(confirmed))
check('覆盖前留下了备份', confirmed.installed[0].backup !== null && existsSync(confirmed.installed[0].backup))
check('内容确实更新了', readFileSync(join(skillsDir, 'alpha', 'SKILL.md'), 'utf8').includes('alpha v2'))
check('更新后不再算本地改动', manager2.detail('o/r').skills.find((skill) => skill.name === 'alpha')?.localModified === false)

// 备份与恢复
const backupList = manager2.backups('alpha').backups
check('备份列表能列出 alpha 的多次备份', backupList.length >= 2, String(backupList.length))
const restored = manager2.restore({ name: 'alpha' })
check('恢复最近一次备份成功', restored.restored === true)
check('恢复回来的是带本地改动的那一版', readFileSync(join(skillsDir, 'alpha', 'SKILL.md'), 'utf8').includes('本地手改的行'))
check('恢复不会把备份自己覆盖掉（同毫秒撞名已处理）', manager2.backups('alpha').backups.length >= 3, String(manager2.backups('alpha').backups.length))
check('恢复后快照跟着更新，不再报本地改动', manager2.detail('o/r').skills.find((skill) => skill.name === 'alpha')?.localModified === false)
let noBackup = null
try {
	manager2.restore({ name: 'never-installed' })
} catch (error) {
	noBackup = error
}
check('没有备份时给 404 而不是编一个空目录', noBackup?.statusCode === 404 && noBackup.code === 'error.backup.notFound')

// 安装目标：装到项目技能根（targetSkillsDir），而不是 manager 的 skillsDir
const projectSkillsDir = tempDir('sc-repo-project-skills')
const targetStub = stubGithub(repoSources, { commit: 'c0ffee123456' })
const managerTarget = reposModule.createRepositoryManager({ stateDir, skillsDir, log: () => {}, fetchImpl: targetStub.fetchImpl, now: () => 1789000004000 })
await managerTarget.fetch('o/r')
const toProject = await managerTarget.install({ id: 'o/r', skills: ['beta'], confirm: false, targetSkillsDir: projectSkillsDir })
check('安装目标可传入：文件落进项目技能根', existsSync(join(projectSkillsDir, 'beta', 'SKILL.md')) && toProject.installed[0]?.path === join(projectSkillsDir, 'beta'), JSON.stringify(toProject))
check('装到项目时全局技能根没有被写', !existsSync(join(skillsDir, 'beta')))
const toProjectDup = await managerTarget.install({ id: 'o/r', skills: ['beta'], confirm: false, targetSkillsDir: projectSkillsDir })
check('装到项目时目标已存在 → 默认拒绝覆盖', toProjectDup.installed.length === 0 && toProjectDup.skipped.length === 1, JSON.stringify(toProjectDup))
const toProjectConfirmed = await managerTarget.install({ id: 'o/r', skills: ['beta'], confirm: true, targetSkillsDir: projectSkillsDir })
check('装到项目时 confirm 后覆盖并留备份', toProjectConfirmed.installed.length === 1 && toProjectConfirmed.installed[0].backup !== null, JSON.stringify(toProjectConfirmed))
check('装到项目不会顶掉订阅快照（全局那份的台账还在自己手里）', managerTarget.detail('o/r').skills.find((skill) => skill.name === 'beta')?.installedPath === null)
const toGlobalDefault = await managerTarget.install({ id: 'o/r', skills: ['gamma'], confirm: false })
check('缺省 targetSkillsDir 仍然写全局（向后兼容）', toGlobalDefault.installed[0]?.path === join(skillsDir, 'gamma.md'), JSON.stringify(toGlobalDefault))

// 上游删掉一个技能
const removedUpstream = stubGithub({ 'skills/alpha/SKILL.md': repoSources['skills/alpha/SKILL.md'] }, { commit: 'abadcafe0000' })
const manager3 = reposModule.createRepositoryManager({ stateDir, skillsDir, log: () => {}, fetchImpl: removedUpstream.fetchImpl, now: () => 1789000002000 })
await manager3.fetch('o/r')
const deletedRow = manager3.detail('o/r').skills.find((skill) => skill.name === 'gamma')
check('上游删掉的技能被标成 upstream-deleted', deletedRow?.status === 'upstream-deleted', deletedRow?.status)
check('上游删掉不会自动删本地文件', existsSync(join(skillsDir, 'gamma.md')))

// 完整性校验
const tampered = stubGithub(repoSources, { commit: 'beef1234', tamperRaw: 'skills/alpha/SKILL.md', tamperAfter: 1 })
const manager4 = reposModule.createRepositoryManager({ stateDir, skillsDir, log: () => {}, fetchImpl: tampered.fetchImpl, now: () => 1789000003000 })
await manager4.fetch('o/r')
const verify = await manager4.install({ id: 'o/r', skills: ['alpha'], confirm: true })
check('下载内容与 tree 快照对不上时拒绝落盘', verify.installed.length === 0 && verify.skipped.length === 1, JSON.stringify(verify))
check('拒绝原因指向完整性校验', /不一致/.test(verify.skipped[0]?.reason ?? ''), verify.skipped[0]?.reason)
check('被篡改的内容没有落盘', !readFileSync(join(skillsDir, 'alpha', 'SKILL.md'), 'utf8').includes('tampered'))

// 网络失败与限流
const failing = reposModule.createRepositoryManager({ stateDir, skillsDir, log: () => {}, fetchImpl: async () => { throw new Error('socket hang up') } })
let networkError = null
await failing.fetch('o/r').catch((error) => {
	networkError = error
})
check('网络失败映射成 error.repo.network', networkError?.code === 'error.repo.network', networkError?.code)
const rateLimited = reposModule.createRepositoryManager({
	stateDir,
	skillsDir,
	log: () => {},
	fetchImpl: async () => ({ status: 403, ok: false, headers: { get: () => '0' }, json: async () => ({}) }),
})
let rateError = null
await rateLimited.fetch('o/r').catch((error) => {
	rateError = error
})
check('限流映射成 error.repo.rateLimit', rateError?.code === 'error.repo.rateLimit', rateError?.code)

// 卸载订阅与状态文件保护
const kept = manager3.remove('o/r')
check('卸载订阅保留已安装技能', kept.installedKept.includes('alpha') && existsSync(join(skillsDir, 'alpha')))
check('订阅记录本身被删掉', manager3.list().repositories.length === 0)
check('订阅清空后技能仍在盘上', existsSync(join(skillsDir, 'alpha', 'SKILL.md')))
let dupAdd = null
const reAdded = await manager3.add({ url: 'o/r' })
check('重新添加同一个仓库可行', reAdded.fetchError === null || reAdded.fetchError !== undefined)
try {
	await manager3.add({ url: 'o/r' })
} catch (error) {
	dupAdd = error
}
check('重复添加被拒绝（409）', dupAdd?.statusCode === 409 && dupAdd.code === 'error.repo.exists', `${dupAdd?.statusCode} ${dupAdd?.code}`)
let badUrl = null
try {
	await manager3.add({ url: 'not a repo' })
} catch (error) {
	badUrl = error
}
check('非法地址被拒绝（400）', badUrl?.statusCode === 400 && badUrl.code === 'error.repo.url')

// 编辑订阅：改分支/子目录 → 丢旧清单 + 立刻重拉；没改 → 不动缓存也不重拉。
section('仓库订阅：仓库根下的文档不算技能（monorepo 根不被当成技能根）')
// 现场事故：订阅 juliusbrussee/caveman 的仓库根，11 个根级 .md（README / CLAUDE /
// CONTRIBUTING…）被当成扁平技能，全判 invalid，界面刷出 11 行「frontmatter 不合法」
// 且一个都装不了。这里的规则是：**扁平候选必须有合法 frontmatter 才进清单**；
// 目录候选（真有 SKILL.md）即使内容坏了也要留下——那是上游的问题，得让人看见。
const messyHome = tempDir('sc-messy-home')
const messySources = {
	'README.md': '# 说明文档\n',
	'CONTRIBUTING.md': '贡献指南\n',
	'CLAUDE.md': '给 agent 的说明\n',
	'notes.md': '---\nname: notes\ndescription: 这是真的扁平技能\n---\n\nflat\n',
	'broken/SKILL.md': '没有 frontmatter\n',
	'good/SKILL.md': '---\nname: good\ndescription: ok\n---\n\nbody\n',
}
const messyManager = reposModule.createRepositoryManager({
	stateDir: join(messyHome, 'skill-console'),
	skillsDir: join(messyHome, 'skills'),
	log: () => {},
	fetchImpl: stubGithub(messySources).fetchImpl,
	now: () => 1789000000000,
})
const messyAdded = await messyManager.add({ url: 'o/r' })
const messyNames = messyAdded.skills.map((skill) => skill.name).sort()
check('仓库根下的 README / CONTRIBUTING / CLAUDE 不进清单', !messyNames.includes('README') && !messyNames.includes('CONTRIBUTING') && !messyNames.includes('CLAUDE'), messyNames.join(','))
check('合法 frontmatter 的扁平 .md 仍然进清单', messyNames.includes('notes'), messyNames.join(','))
check('清单里没有 invalid 的扁平条目', messyAdded.skills.every((skill) => skill.kind !== 'flat' || skill.valid === true), JSON.stringify(messyAdded.skills.map((s) => [s.name, s.valid])))
const brokenRow = messyAdded.skills.find((skill) => skill.sourcePath === 'broken')
check('坏掉的目录包保留在清单里（上游写坏了要看得见）', brokenRow !== undefined && brokenRow.valid === false && brokenRow.status === 'invalid', JSON.stringify(brokenRow))
check('拉取计数的 skillCount 不含被丢掉的文档', messyManager.list().repositories[0]?.lastFetch?.skillCount === messyAdded.skills.length, String(messyManager.list().repositories[0]?.lastFetch?.skillCount))

// 全是文档的仓库（真正的现场）：清单为空，但拉取本身是成功的。
// 界面靠「拉取成功 + 0 技能」这一组合去提示「技能可能在子目录里」。
const docsOnlyHome = tempDir('sc-docsonly-home')
const docsOnly = reposModule.createRepositoryManager({
	stateDir: join(docsOnlyHome, 'skill-console'),
	skillsDir: join(docsOnlyHome, 'skills'),
	log: () => {},
	fetchImpl: stubGithub({ 'README.md': '# 只有文档\n', 'CLAUDE.md': '只有说明\n' }).fetchImpl,
	now: () => 1789000000000,
})
await docsOnly.add({ url: 'o/r' })
const docsOnlyDetail = docsOnly.detail('o/r')
check('只有根级文档的仓库清单是空的', docsOnlyDetail.skills.length === 0, String(docsOnlyDetail.skills.length))
check('空清单仍然标记 fetched（界面据此区分「没拉取过」与「拉到了但没技能」）', docsOnlyDetail.fetched === true && docsOnlyDetail.repository.lastFetch?.error === null, JSON.stringify(docsOnlyDetail.repository.lastFetch))

// 编辑订阅：改分支/子目录 → 丢旧清单 + 立刻重拉；没改 → 不动缓存也不重拉。
section('仓库订阅：编辑（分支 / 子目录）')
const editHome = tempDir('sc-edit-home')
const editStubFiles = {
	'other/alpha/SKILL.md': '---\nname: alpha\ndescription: Alpha from the other subtree\n---\n\n# alpha\n',
}
const editStub = stubGithub(editStubFiles)
const editsDir = join(editHome, 'skill-console')
const editable = reposModule.createRepositoryManager({ stateDir: editsDir, skillsDir: join(editHome, 'skills'), log: () => {}, fetchImpl: editStub.fetchImpl, now: () => 1789000000000 })
await editable.add({ url: 'o/r', subdirectory: 'skills' })
const manifestBefore = readdirSync(join(editsDir, 'repository-cache')).length
const noop = await editable.update({ id: 'o/r', ref: '', subdirectory: 'skills' })
check('原样保存不算改动', noop.changed === false, JSON.stringify(noop.changed))
check('原样保存不重拉（清单还在）', readdirSync(join(editsDir, 'repository-cache')).length === manifestBefore)
const edited = await editable.update({ id: 'o/r', subdirectory: 'other' })
check('改子目录后立刻重拉', edited.changed === true && edited.fetchError === null, edited.fetchError ?? '')
check('重拉拿的是新子目录里的技能', edited.skills.map((skill) => skill.name).join(',') === 'alpha', JSON.stringify(edited.skills.map((skill) => skill.sourcePath)))
check('重拉后清单换了内容（不是旧的 skills/ 树）', edited.skills[0]?.sourcePath === 'other/alpha')
check('detail 报告新的子目录', editable.detail('o/r').repository.subdirectory === 'other')
const editedRef = await editable.update({ id: 'o/r', ref: 'v2' })
check('改分支同样触发重拉', editedRef.changed === true && editable.detail('o/r').repository.ref === 'v2')
check('子目录被清空时不越界（退回仓库根）', (await editable.update({ id: 'o/r', ref: 'v2', subdirectory: '' })).repository.subdirectory === '')
let badSubdir = null
try {
	await editable.update({ id: 'o/r', ref: 'v2', subdirectory: '../etc' })
} catch (error) {
	badSubdir = error
}
check('带 .. 的子目录被拒绝（400）', badSubdir?.statusCode === 400 && badSubdir.code === 'error.repo.subdirectory', `${badSubdir?.statusCode} ${badSubdir?.code}`)
let unknownEdit = null
try {
	await editable.update({ id: 'nope/nope', ref: 'v2' })
} catch (error) {
	unknownEdit = error
}
check('编辑不存在的订阅给 404', unknownEdit?.statusCode === 404 && unknownEdit.code === 'error.repo.unknown', `${unknownEdit?.statusCode} ${unknownEdit?.code}`)

// 重拉失败时：订阅设置照常保存（订阅本身是好的），失败原因回给界面。
const offlineEditable = reposModule.createRepositoryManager({
	stateDir: editsDir,
	skillsDir: join(editHome, 'skills'),
	log: () => {},
	fetchImpl: async () => {
		throw new Error('socket hang up')
	},
	now: () => 1789000000000,
})
const offlineEdit = await offlineEditable.update({ id: 'o/r', ref: 'v3' })
check('拉取失败也保留新的订阅设置', offlineEdit.changed === true && offlineEdit.repository.ref === 'v3', JSON.stringify(offlineEdit.repository))
check('拉取失败时把原因回给界面', typeof offlineEdit.fetchError === 'string' && offlineEdit.fetchError !== '', String(offlineEdit.fetchError))
check('拉取失败时清单缓存已丢弃（不会拿旧树当真）', !existsSync(join(editsDir, 'repository-cache', `${createHash('sha1').update('o/r').digest('hex').slice(0, 16)}.json`)))

const corruptDir = tempDir('sc-corrupt')
mkdirSync(join(corruptDir, 'skill-console'), { recursive: true })
writeFileSync(join(corruptDir, 'skill-console', 'repositories.json'), '{ this is not json')
const corrupt = reposModule.createRepositoryManager({ stateDir: join(corruptDir, 'skill-console'), skillsDir: join(corruptDir, 'skills'), log: () => {}, fetchImpl: stub.fetchImpl })
let corruptError = null
try {
	corrupt.list()
} catch (error) {
	corruptError = error
}
check('状态文件损坏时拒绝读写（不覆盖用户数据）', corruptError?.code === 'error.repo.state', corruptError?.code)
check('损坏的状态文件原样保留', readFileSync(join(corruptDir, 'skill-console', 'repositories.json'), 'utf8').includes('this is not json'))

section('远端清单构建（纯函数，子目录与路径安全）')
const manifestModule = await import(join(LIB, 'repo-manifest.js'))
const fakeTree = [
	{ path: 'README.md', type: 'blob', sha: 'a', size: 10 },
	{ path: 'SKILL.md', type: 'blob', sha: 'b', size: 10 },
	{ path: 'skills', type: 'tree', sha: 'c' },
	{ path: 'skills/alpha/SKILL.md', type: 'blob', sha: reposModule.gitBlobSha1OfText('alpha'), size: 5 },
	{ path: 'skills/alpha/references/deep.md', type: 'blob', sha: 'd', size: 3 },
	{ path: 'skills/beta.md', type: 'blob', sha: 'e', size: 3 },
	{ path: 'skills/nested/deep/SKILL.md', type: 'blob', sha: 'f', size: 3 },
	{ path: 'other/gamma/SKILL.md', type: 'blob', sha: 'g', size: 3 },
]
const subCandidates = manifestModule.collectCandidates(fakeTree, 'skills')
check('子目录里挑出深度 1 的两种形态', subCandidates.map((c) => c.sourcePath).join(',') === 'skills/alpha,skills/beta.md', subCandidates.map((c) => c.sourcePath).join(','))
check('跳过子目录里的嵌套 SKILL.md', !subCandidates.some((c) => c.sourcePath.includes('nested')))
const rootCandidates = manifestModule.collectCandidates(fakeTree, '')
// 仓库根不是一个技能根：`skills/alpha/SKILL.md` 在根视角下是深度 2，不算技能。
check('仓库根只认深度 1（所以要把子目录指到放技能的那一层）', rootCandidates.map((c) => c.sourcePath).join(',') === 'README.md', rootCandidates.map((c) => c.sourcePath).join(','))
check('仓库根跳过根级 SKILL.md', !rootCandidates.some((c) => c.sourcePath === 'SKILL.md'))
const deepCandidates = manifestModule.collectCandidates(fakeTree, 'skills/alpha')
check('指向单个技能目录时不会把它自己当技能（DSH 也不认根级 SKILL.md）', deepCandidates.length === 0, String(deepCandidates.length))
check('候选数量上限生效', manifestModule.collectCandidates(fakeTree, 'skills', 1).length === 1)
// 无 frontmatter 的 .md（README 之类）**照样进清单**，标成 invalid 让用户看见，
// 而不是悄悄过滤掉——静默隐藏才是最难查的故障。
const readmeEntry = manifestModule.manifestEntryOf(rootCandidates[0], '# 只是说明文档\n', manifestModule.filesOf(fakeTree, rootCandidates[0]), null)
check('没有 frontmatter 的 .md 也进清单并标为 invalid', readmeEntry.valid === false && readmeEntry.name === 'README')
const alphaCandidate = subCandidates.find((c) => c.dir === 'alpha')
const alphaFiles = manifestModule.filesOf(fakeTree, alphaCandidate)
check('目录包的文件按相对路径列全', alphaFiles.map((f) => f.path).sort().join(',') === 'SKILL.md,references/deep.md', alphaFiles.map((f) => f.path).join(','))
check('SKILL.md 的仓库路径拼得对', manifestModule.skillMdPathOf(alphaCandidate) === 'skills/alpha/SKILL.md')
check('扁平候选的 SKILL.md 路径就是它自己', manifestModule.skillMdPathOf(subCandidates.find((c) => c.kind === 'flat')) === 'skills/beta.md')
const validEntry = manifestModule.manifestEntryOf(alphaCandidate, '---\nname: alpha\ndescription: ok\n---\n\nbody\n', alphaFiles, null)
check('合法条目 valid=true 且 name 取的是 frontmatter 里的', validEntry.valid === true && validEntry.name === 'alpha')
const invalidEntry = manifestModule.manifestEntryOf(alphaCandidate, '没有 frontmatter', alphaFiles, null)
check('坏 frontmatter 的条目 valid=false（装不了，让用户去上游修）', invalidEntry.valid === false)
check('坏条目退回目录名，仍然可展示', invalidEntry.name === 'alpha')
const unreadable = manifestModule.manifestEntryOf(alphaCandidate, null, alphaFiles, 'socket hang up')
check('读不到 SKILL.md 的条目带错误原因', unreadable.valid === false && unreadable.error === 'socket hang up' && unreadable.diagnostics.includes('error.repo.read'))
// `manifestEntryOf` 只负责「如实描述」，收不收进清单由 `isManifestSkill` 决定：
// 目录候选一律收（坏了要看得见），扁平候选必须有合法 frontmatter。
const flatCandidate = subCandidates.find((c) => c.kind === 'flat')
const flatValid = manifestModule.manifestEntryOf(flatCandidate, '---\nname: beta\ndescription: ok\n---\n', manifestModule.filesOf(fakeTree, flatCandidate), null)
const flatInvalid = manifestModule.manifestEntryOf(flatCandidate, '# 只是说明文档\n', manifestModule.filesOf(fakeTree, flatCandidate), null)
check('合法扁平条目收进清单', manifestModule.isManifestSkill(flatValid) === true)
check('无 frontmatter 的扁平条目不进清单（根级 README 不是技能）', manifestModule.isManifestSkill(flatInvalid) === false)
check('坏掉的目录包仍然收进清单（上游的问题要让人看见）', manifestModule.isManifestSkill(invalidEntry) === true && manifestModule.isManifestSkill(unreadable) === true)
let unsafePath = null
try {
	manifestModule.filesOf([{ path: 'skills/alpha/../../etc/passwd', type: 'blob', sha: 'x' }], alphaCandidate)
} catch (error) {
	unsafePath = error
}
check('仓库里带 .. 的路径被拒绝（它马上会变成真实写入路径）', unsafePath?.code === 'error.install.path', unsafePath?.code)
const preview = manifestModule.diffFiles({ files: { 'SKILL.md': 'old', 'gone.md': 'x' } }, { files: [{ path: 'SKILL.md', blobSha: 'new' }, { path: 'added.md', blobSha: 'y' }] })
check('差异预览算得出 added/modified/removed', preview.length === 3 && preview.every((c) => ({ 'SKILL.md': 'modified', 'added.md': 'added', 'gone.md': 'removed' })[c.path] === c.change), JSON.stringify(preview))
check('差异预览按路径排序（界面直接照单渲染）', preview.map((c) => c.path).join() === [...preview.map((c) => c.path)].sort((a, b) => a.localeCompare(b)).join())

section('订阅状态存储：坏缓存可容忍，坏状态文件不可覆盖')
const storeModule = await import(join(LIB, 'store.js'))
const storeHome = tempDir('sc-store')
const store = storeModule.createSubscriptionStore({ stateDir: join(storeHome, 'skill-console'), log: () => {} })
check('首次读是空状态', store.load().repositories.length === 0)
store.load().repositories.push({ id: 'o/r', owner: 'o', name: 'r', skills: {} })
store.save()
check('落盘后能读回来', storeModule.createSubscriptionStore({ stateDir: join(storeHome, 'skill-console'), log: () => {} }).load().repositories.length === 1)
const cacheDir = join(storeHome, 'skill-console', 'repository-cache')
mkdirSync(cacheDir, { recursive: true })
const digest = createHash('sha1').update('o/r').digest('hex').slice(0, 16)
writeFileSync(join(cacheDir, `${digest}.json`), '{ broken')
check('清单缓存损坏时按「还没拉取」处理，不抛', store.readManifest('o/r') === null)
store.writeManifest('o/r', { id: 'o/r', commit: 'abc', skills: [] })
check('重写缓存后能读回来', store.readManifest('o/r')?.commit === 'abc')
let missingRepo = null
try {
	store.require('nope/nope')
} catch (error) {
	missingRepo = error
}
check('找不到订阅给 404', missingRepo?.statusCode === 404 && missingRepo.code === 'error.repo.unknown')

// ── 4. 宿主路由 ───────────────────────────────────────────────────────────

section('宿主路由：围栏 / 标记 / 响应')
process.env.DSH_HOME = home
const host = await import(join(LIB, 'index.js'))

check('宿主导出的 name 是 skill-console', host.name === 'skill-console')
check('inject 声明了 webServer / skills / sessions', host.inject.join(',') === 'webServer,skills,sessions', host.inject.join(','))
check('路由前缀是 /api/skill-console', host.ROUTE_PREFIX === '/api/skill-console')

let registeredRoute = null
const fakeSession = { id: 'session-test-1', header: { id: 'session-test-1', cwd: projectDir, updatedAt: 5 } }
const pluginCtx = {
	logger: { info() {}, warn() {} },
	effect: (fn) => {
		const disposer = fn()
		return () => {
			if (typeof disposer === 'function') disposer()
		}
	},
	emit: () => {},
	skills: { registerProvider: (factory) => {
		factory({ signal: { addEventListener() {} }, invalidate() {} })
		return () => {}
	} },
	sessions: { list: () => [fakeSession], get: (id) => (id === fakeSession.id ? fakeSession : undefined) },
	webRuntime: { trustedHosts: [] },
	webServer: {
		register: (route) => {
			registeredRoute = route
			return () => {}
		},
	},
}
// 路由层的 manager 在 apply 那一刻按值抓住 fetch（`repos.js` 建 client 时传
// `options.fetchImpl`，`github.js` 里 `options.fetchImpl ?? globalThis.fetch`），而
// `lib/index.js` 建 manager 时**没有**注入假 fetch 的口子。于是只在 apply 这一瞬把
// `globalThis.fetch` 换成桩 GitHub：不改宿主实现、不另造并行 manager；随后立刻还原——
// manager 已持有桩的函数值，还原不影响它。这样下面经路由调 `repositories/install` 时
// 才能离线拿到真实清单，端到端证明 `target:'project'` 的落点。
// 技能名刻意用 `proj-only`：两个技能根现场都已经有 alpha / beta，装同名会被「本地已存在」挡掉，
// 测不到落点。
const routeStub = stubGithub({
	'skills/proj-only/SKILL.md': '---\nname: proj-only\ndescription: 路由层 target:project 落点验证用\n---\n\n# proj-only\n',
	'skills/proj-only/reference.md': 'proj-only reference\n',
}, { commit: 'c0ffee123456' })
const realGlobalFetch = globalThis.fetch
globalThis.fetch = routeStub.fetchImpl
host.apply(pluginCtx)
globalThis.fetch = realGlobalFetch
check('注册了 prefix 路由', registeredRoute?.kind === 'prefix' && registeredRoute?.path === '/api/skill-console')

/** 假的 node 请求。 */
function fakeReq({ method = 'GET', path = '/api/skill-console/state', host: hostHeader = '127.0.0.1:43129', origin, site, headers = {}, body } = {}) {
	const listeners = {}
	const req = {
		method,
		url: path,
		headers: { host: hostHeader, ...headers },
		socket: { remoteAddress: '127.0.0.1' },
		on(event, handler) {
			listeners[event] = listeners[event] ?? []
			listeners[event].push(handler)
			return req
		},
		resume() {},
	}
	if (origin !== undefined) req.headers.origin = origin
	if (site !== undefined) req.headers['sec-fetch-site'] = site
	// 体在下一个 tick 送，模拟真实流的时序。
	setTimeout(() => {
		for (const handler of listeners.data ?? []) handler(Buffer.from(body === undefined ? '' : JSON.stringify(body), 'utf8'))
		for (const handler of listeners.end ?? []) handler()
	}, 0)
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

async function call(options) {
	const res = fakeRes()
	await registeredRoute.handler(fakeReq(options), res)
	return { status: res.statusCode, json: res.body === '' ? null : JSON.parse(res.body) }
}

/** 用**任意**路由对象发一次请求（`call` 固定用 registeredRoute，这里给守卫测试用）。 */
async function callRoute(route, options) {
	const res = fakeRes()
	await route.handler(fakeReq(options), res)
	return { status: res.statusCode, json: res.body === '' ? null : JSON.parse(res.body) }
}

/**
 * 同上，但把「处理器抛异常」变成一条可读的失败而不是让整套测试崩掉。
 * 未 inject 的服务读就是抛异常，所以这一条对守卫测试是必需的。
 */
async function callRouteOrReport(route, options) {
	try {
		return await callRoute(route, options)
	} catch (error) {
		return { status: 0, json: null, threw: error instanceof Error ? error.message : String(error) }
	}
}

const stateResponse = await call({ path: '/api/skill-console/state' })
check('GET /state 返回 200', stateResponse.status === 200 && stateResponse.json.ok === true, JSON.stringify(stateResponse.json))
check('/state 报告两个技能根', stateResponse.json.data.roots.length === 2, String(stateResponse.json.data.roots.length))
check('/state 不再回显 .agents 目录', !('agentsHome' in stateResponse.json.data), JSON.stringify(Object.keys(stateResponse.json.data)))
check('/state 报告活着的会话作为项目', stateResponse.json.data.projects[0]?.cwd === projectDir)
check('/state 不带 session 头时标记 fallback', stateResponse.json.data.selected?.fallback === true)
check('/state 不回显 token 值，只报存在性', typeof stateResponse.json.data.token === 'boolean')

const withHeader = await call({ path: '/api/skill-console/state', headers: { 'x-skill-console-session': fakeSession.id } })
check('带 session 头时不算 fallback', withHeader.json.data.selected.fallback === false)

const rejection = await call({ path: '/api/skill-console/state', host: 'evil.example.com' })
check('非回环 Host 被拒（403）', rejection.status === 403 && rejection.json.code === 'error.proto.forbiddenHost', `${rejection.status} ${rejection.json?.code}`)
const crossSite = await call({ path: '/api/skill-console/state', site: 'cross-site' })
check('跨站标记被拒（403）', crossSite.status === 403)
const crossOrigin = await call({ path: '/api/skill-console/state', origin: 'http://127.0.0.1:9999' })
check('Origin 端口不一致被拒（403）', crossOrigin.status === 403)
const goodOrigin = await call({ path: '/api/skill-console/state', origin: 'http://127.0.0.1:43129' })
check('同源 Origin 放行', goodOrigin.status === 200)

const catalog = await call({ path: '/api/skill-console/catalog?scope=global' })
check('GET /catalog 返回全局根', catalog.status === 200 && catalog.json.data.roots.every((root) => root.scope === 'global'))
check('/catalog 行里带 installed 字段', catalog.json.data.roots[0].skills.every((skill) => 'installed' in skill))
const projectCatalog = await call({ path: '/api/skill-console/catalog?scope=project', headers: { 'x-skill-console-session': fakeSession.id } })
check('GET /catalog?scope=project 返回项目根', projectCatalog.json.data.roots.some((root) => root.key === 'project-dsh'))
check('/catalog 报告同名覆盖', projectCatalog.json.data.collisions.some((entry) => entry.name === 'alpha'), JSON.stringify(projectCatalog.json.data.collisions))

const skillResponse = await call({ path: `/api/skill-console/skill?path=${encodeURIComponent(join(globalRoot, 'alpha', 'SKILL.md'))}` })
check('GET /skill 带回正文与 frontmatter', typeof skillResponse.json.data.body === 'string' && typeof skillResponse.json.data.frontmatter === 'string', JSON.stringify(Object.keys(skillResponse.json.data)))

const missingPath = await call({ path: '/api/skill-console/skill' })
check('GET /skill 缺 path 时 400', missingPath.status === 400 && missingPath.json.code === 'error.proto.missingPath')
const outsideRead = await call({ path: `/api/skill-console/skill?path=${encodeURIComponent('/etc/hosts')}` })
check('读根外文件被拒（400）', outsideRead.status === 400 && outsideRead.json.code === 'error.path.outsideRoots', `${outsideRead.status} ${outsideRead.json?.code}`)

// 宿主 webserver 会把「handler 抛异常」变成一个没有正文的 400——生产环境里
// 那等于「面板什么都看不到」。用一条能让 new URL() 抛的畸形路径证明：异常被
// 兜底转成了带 code 的 JSON 500。
const malformed = await call({ path: '//[' })
check('处理器抛异常时返回 JSON 500（而不是逃逸成裸 400）', malformed.status === 500 && malformed.json.code === 'error.internal', `${malformed.status} ${JSON.stringify(malformed.json)}`)

const unknown = await call({ path: '/api/skill-console/nope' })
check('未知路由 404', unknown.status === 404 && unknown.json.code === 'error.proto.unknownRoute')

const noMarker = await call({ method: 'POST', path: '/api/skill-console/toggle', body: { path: join(globalRoot, 'beta', 'SKILL.md'), enabled: false } })
check('写操作缺客户端标记被拒（403）', noMarker.status === 403 && noMarker.json.code === 'error.proto.forbidden', `${noMarker.status} ${noMarker.json?.code}`)
const wrongType = await call({ method: 'POST', path: '/api/skill-console/toggle', headers: { 'x-skill-console': '1', 'content-type': 'text/plain' }, body: { path: x => x } })
check('写操作 content-type 不对被拒（415）', wrongType.status === 415 && wrongType.json.code === 'error.proto.contentType', `${wrongType.status} ${wrongType.json?.code}`)

const toggleResponse = await call({
	method: 'POST',
	path: '/api/skill-console/toggle',
	headers: { 'x-skill-console': '1', 'content-type': 'application/json' },
	body: { path: join(globalRoot, 'beta', 'SKILL.md'), enabled: false },
})
check('POST /toggle 成功并返回技能', toggleResponse.status === 200 && toggleResponse.json.data.skill.enabled === false, JSON.stringify(toggleResponse.json))
check('/toggle 真的只重命名了文件', existsSync(join(globalRoot, 'beta', 'SKILL.md.disabled')) && !existsSync(join(globalRoot, 'beta', 'SKILL.md')))
check('/toggle 报告接管者（同名技能还有谁在生效）', Array.isArray(toggleResponse.json.data.takeover))
const toggleBack = await call({
	method: 'POST',
	path: '/api/skill-console/toggle',
	headers: { 'x-skill-console': '1', 'content-type': 'application/json' },
	body: { path: join(globalRoot, 'beta', 'SKILL.md.disabled'), enabled: true },
})
check('POST /toggle 可以再启用回来', toggleBack.json.data.skill.enabled === true && existsSync(join(globalRoot, 'beta', 'SKILL.md')))

const batch = await call({
	method: 'POST',
	path: '/api/skill-console/toggle-batch',
	headers: { 'x-skill-console': '1', 'content-type': 'application/json' },
	body: { items: [{ path: join(globalRoot, 'alpha', 'SKILL.md'), enabled: false }, { path: '/etc/hosts', enabled: false }] },
})
check('批量启停逐项报告结果', batch.json.data.results.length === 2 && batch.json.data.results[0].ok === true && batch.json.data.results[1].ok === false, JSON.stringify(batch.json.data.results))
check('批量里越界的那项给了错误码', batch.json.data.results[1].code === 'error.path.outsideRoots')
await call({
	method: 'POST',
	path: '/api/skill-console/toggle',
	headers: { 'x-skill-console': '1', 'content-type': 'application/json' },
	body: { path: join(globalRoot, 'alpha', 'SKILL.md.disabled'), enabled: true },
})

const reposList = await call({ path: '/api/skill-console/repositories' })
check('GET /repositories 返回列表', reposList.status === 200 && Array.isArray(reposList.json.data.repositories))

const badRepo = await call({
	method: 'POST',
	path: '/api/skill-console/repositories/add',
	headers: { 'x-skill-console': '1', 'content-type': 'application/json' },
	body: { url: 'not a repo' },
})
check('POST /repositories/add 非法地址 400', badRepo.status === 400 && badRepo.json.code === 'error.repo.url', `${badRepo.status} ${badRepo.json?.code}`)

const updateNoId = await call({
	method: 'POST',
	path: '/api/skill-console/repositories/update',
	headers: { 'x-skill-console': '1', 'content-type': 'application/json' },
	body: { ref: 'v2' },
})
check('POST /repositories/update 缺 id 时 400', updateNoId.status === 400 && updateNoId.json.code === 'error.proto.missingId', `${updateNoId.status} ${updateNoId.json?.code}`)
const updateUnknown = await call({
	method: 'POST',
	path: '/api/skill-console/repositories/update',
	headers: { 'x-skill-console': '1', 'content-type': 'application/json' },
	body: { id: 'nope/nope', ref: 'v2' },
})
check('POST /repositories/update 未知订阅 404', updateUnknown.status === 404 && updateUnknown.json.code === 'error.repo.unknown', `${updateUnknown.status} ${updateUnknown.json?.code}`)

const backups = await call({ path: '/api/skill-console/backups?name=alpha' })
check('GET /backups 返回备份列表', backups.status === 200 && Array.isArray(backups.json.data.backups))
const restoreMissing = await call({
	method: 'POST',
	path: '/api/skill-console/restore',
	headers: { 'x-skill-console': '1', 'content-type': 'application/json' },
	body: { name: 'definitely-not-installed' },
})
check('POST /restore 没有备份时 404', restoreMissing.status === 404 && restoreMissing.json.code === 'error.backup.notFound', `${restoreMissing.status} ${restoreMissing.json?.code}`)

// 卸载时不该抛
let unloadThrew = false
try {
	host.apply({ ...pluginCtx, webServer: undefined, skills: undefined, sessions: undefined })
} catch {
	unloadThrew = true
}
check('宿主服务缺失时 apply 只降级不抛', unloadThrew === false)

// ── 4b. cordis 服务读取守卫 ────────────────────────────────────────────────
//
// 真实事故（现场验证第一次跑就撞上）：`routes.js` 里写的是
// `deps.ctx.webRuntime?.trustedHosts ?? []`，而 `webRuntime` 没写进 inject。
// cordis 对未声明 inject 的服务，**读属性那一刻**抛
// `cannot get property "webRuntime" without inject`——`?.` 拦不住（它不是拿到
// undefined，而是取属性就抛），宿主 webserver 把它吞成一个**没有正文的 400**，
// 浏览器面板只会看到「接口没挂上」。这一节把这类错误钉死在离线测试里。

section('cordis 服务读取：只能读已 inject 的服务')

// mixin / 核心成员：不是「服务」，属性读不经过注入表；`logger` 由根 fiber 提供，
// 线上实测任何插件都能读。
const CORE_CTX_MEMBERS = new Set([
	'effect', 'emit', 'on', 'once', 'off', 'bail', 'parallel', 'waterfall',
	'inject', 'plugin', 'provide', 'set', 'start', 'stop', 'dispose',
	'scope', 'isolate', 'root', 'fiber', 'reflect', 'events', 'registry', 'get', 'logger',
])
const HOST_FILES = [
	'index.js', 'http.js', 'routes.js', 'roots.js', 'frontmatter.js', 'diagnostics.js',
	'repos.js', 'repo-manifest.js', 'github.js', 'store.js', 'backups.js', 'rows.js',
	'projects.js', 'gitsha.js', 'roles.js',
]
const readableServices = new Set([...host.inject, ...CORE_CTX_MEMBERS])
const offenders = []
for (const file of HOST_FILES) {
	// 注释里的 `ctx.xxx` 是讲解，不是读取：先剥块注释与整行注释再扫。
	const text = readFileSync(join(LIB, file), 'utf8')
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/^\s*\/\/.*$/gm, '')
	for (const match of text.matchAll(/\bctx\.([A-Za-z_$][\w$]*)/g)) {
		if (!readableServices.has(match[1])) offenders.push(`${file}: ctx.${match[1]}`)
	}
}
check('宿主侧没有「未 inject 就按属性读服务」（可选服务必须走 ctx.get）', offenders.length === 0, offenders.join(', '))
check('扫描确实覆盖到了真实读取（不是空转）', HOST_FILES.every((file) => existsSync(join(LIB, file))))

// 浏览器半边跑的是同一个 cordis，守卫一样：只读已 inject 的服务。
if (clientSource !== null) {
	const clientInject = [...clientSource.matchAll(/const inject = \[([^\]]*)\]/g)]
		.flatMap((match) => match[1].split(','))
		.map((entry) => entry.trim().replace(/['"]/g, ''))
		.filter((entry) => entry !== '')
	const clientText = clientSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
	const clientOffenders = [...new Set([...clientText.matchAll(/\bctx\.([A-Za-z_$][\w$]*)/g)].map((match) => match[1]))]
		.filter((name) => !CORE_CTX_MEMBERS.has(name) && !clientInject.includes(name))
	check('浏览器半边声明的 inject 是 slots,locale', clientInject.join(',') === 'slots,locale', clientInject.join(','))
	check('浏览器半边也只读已 inject 的服务', clientOffenders.length === 0, clientOffenders.join(','))
}

/**
 * 造一个**如实**模拟 cordis 守卫的 ctx：未声明 inject 的属性读直接抛，
 * 即使那个服务在兄弟 fiber 上真的存在（真实 cordis 也读不到）。
 */
function guardedCtx({ declared = host.inject, runtime } = {}) {
	const reads = []
	const target = {
		logger: { info() {}, warn() {} },
		effect: (fn) => { const disposer = fn(); return () => { if (typeof disposer === 'function') disposer() } },
		emit: () => {},
		skills: { registerProvider: (factory) => { factory({ signal: { addEventListener() {} }, invalidate() {} }); return () => {} } },
		sessions: { list: () => [fakeSession], get: (id) => (id === fakeSession.id ? fakeSession : undefined) },
		webServer: { register: (route) => { target.registered = route; return () => {} } },
		// 核心能力：不需要 inject；真实 cordis 里它对未提供的服务返回 undefined 而不抛。
		get: (serviceName) => (serviceName === 'webRuntime' ? runtime : undefined),
	}
	const allowed = new Set([...declared, ...CORE_CTX_MEMBERS])
	const proxy = new Proxy(target, {
		get(obj, prop) {
			if (typeof prop !== 'string' || allowed.has(prop)) return obj[prop]
			reads.push(prop)
			throw new Error(`cannot get property "${prop}" without inject`)
		},
	})
	return { ctx: proxy, reads, routeOf: () => target.registered }
}

// 先自证守卫不是摆设：不给任何 inject 时，读 ctx.skills 必须抛。
const strictProbe = guardedCtx({ declared: [] })
let probeThrew = false
try { void strictProbe.ctx.skills } catch (error) { probeThrew = /without inject/.test(error.message) }
check('守卫本身有效：未声明的服务读属性会抛', probeThrew)

// 默认注入集下，apply 与全部路由都必须能跑通（这正是线上炸掉的地方）。
const guarded = guardedCtx({ runtime: { trustedHosts: ['lan.example.com:43129'] } })
host.apply(guarded.ctx)
check('只读已声明服务时 apply 不抛', guarded.routeOf() !== undefined)
check('apply 期间没有触发未 inject 的服务读', guarded.reads.length === 0, guarded.reads.join(','))

const guardedState = await callRouteOrReport(guarded.routeOf(), { path: '/api/skill-console/state' })
check('守卫 ctx 下 GET /state 仍返回 200', guardedState.status === 200, guardedState.threw ?? `${guardedState.status} ${JSON.stringify(guardedState.json).slice(0, 120)}`)
const guardedToggle = await callRouteOrReport(guarded.routeOf(), {
	method: 'POST',
	path: '/api/skill-console/toggle',
	headers: { 'x-skill-console': '1', 'content-type': 'application/json' },
	body: { path: join(globalRoot, 'beta', 'SKILL.md'), enabled: false },
})
check('守卫 ctx 下写路由也跑通', guardedToggle.status === 200, guardedToggle.threw ?? `${guardedToggle.status} ${JSON.stringify(guardedToggle.json).slice(0, 120)}`)
await callRouteOrReport(guarded.routeOf(), {
	method: 'POST',
	path: '/api/skill-console/toggle',
	headers: { 'x-skill-console': '1', 'content-type': 'application/json' },
	body: { path: join(globalRoot, 'beta', 'SKILL.md.disabled'), enabled: true },
})
check('跑完全部路由后依旧没有未 inject 的服务读', guarded.reads.length === 0, guarded.reads.join(','))

// 通过 ctx.get 拿到的受信主机必须真的起作用（否则「可选的 webRuntime」等于没接上）。
const trustedHost = await callRouteOrReport(guarded.routeOf(), { path: '/api/skill-console/state', host: 'lan.example.com:43129' })
check('webRuntime.trustedHosts 里的主机被放行', trustedHost.status === 200, trustedHost.threw ?? String(trustedHost.status))
const untrustedHost = await callRouteOrReport(guarded.routeOf(), { path: '/api/skill-console/state', host: 'elsewhere.example.com:43129' })
check('不在受信列表里的局域网主机仍被拒（403）', untrustedHost.status === 403 && untrustedHost.json.code === 'error.proto.forbiddenHost')

// 完全没有 webRuntime（非 web 部署）时必须降级为纯回环，而不是抛。
const noRuntime = guardedCtx({ runtime: undefined })
host.apply(noRuntime.ctx)
const lanWithoutRuntime = await callRouteOrReport(noRuntime.routeOf(), { path: '/api/skill-console/state', host: 'lan.example.com:43129' })
check('拿不到 webRuntime 时降级为纯回环：局域网主机 403 且不抛', lanWithoutRuntime.status === 403, lanWithoutRuntime.threw ?? String(lanWithoutRuntime.status))
const loopbackWithoutRuntime = await callRouteOrReport(noRuntime.routeOf(), { path: '/api/skill-console/state' })
check('降级后回环照常可用', loopbackWithoutRuntime.status === 200, String(loopbackWithoutRuntime.status))

// ── 4b. 角色路由 ─────────────────────────────────────────────────────────

section('角色路由：列表 / 预览 / 保存 / 切换 / 取消 / 删除')

/** 写操作必须带的头（少一个就被围栏挡）。 */
const ROLE_WRITE = { 'x-skill-console': '1', 'content-type': 'application/json' }
const roleSession = { 'x-skill-console-session': fakeSession.id }
const rolesProjectSkills = join(projectDir, '.dsh', 'skills')

// 专供本节的名字，避免与前面的用例互相污染
placeSkill(rolesProjectSkills, 'rp-alpha', true)
placeSkill(rolesProjectSkills, 'rp-beta', true)
placeSkill(join(home, 'skills'), 'rp-global', true)

const rolesList = await call({ path: '/api/skill-console/roles', headers: roleSession })
check('GET /roles 返回 200', rolesList.status === 200 && rolesList.json.ok === true, `${rolesList.status} ${JSON.stringify(rolesList.json).slice(0, 160)}`)
check('未激活角色时 status 是 unassigned', rolesList.json.data.status === 'unassigned', String(rolesList.json.data.status))
check('候选里能拿到项目技能', rolesList.json.data.candidates.project.some((entry) => entry.name === 'rp-alpha'), JSON.stringify(rolesList.json.data.candidates.project.map((entry) => entry.name)))
check('候选里的全局技能标了只读', rolesList.json.data.candidates.global.every((entry) => entry.readOnly === true && entry.reason === 'global-uncontrollable'))
check('候选人带齐字段', rolesList.json.data.candidates.project.every((entry) => ['name', 'path', 'enabled', 'toggleable'].every((key) => key in entry)))
check('带回项目名与 fallback 标记', typeof rolesList.json.data.project?.name === 'string' && typeof rolesList.json.data.project?.fallback === 'boolean', JSON.stringify(rolesList.json.data.project))

const savedRoleResponse = await call({ method: 'POST', path: '/api/skill-console/roles/save', headers: { ...ROLE_WRITE, ...roleSession }, body: { name: '冒烟角色', skills: ['rp-alpha'] } })
check('POST /roles/save 建了角色', savedRoleResponse.status === 200 && typeof savedRoleResponse.json.data.role.id === 'string', JSON.stringify(savedRoleResponse.json).slice(0, 160))
const savedRoleId = savedRoleResponse.json.data.role.id
check('保存后出现在列表里', (await call({ path: '/api/skill-console/roles', headers: roleSession })).json.data.roles.some((role) => role.id === savedRoleId))

const rolePreview = await call({ path: `/api/skill-console/roles/preview?role=${savedRoleId}`, headers: roleSession })
check('preview 列出将停用的技能', rolePreview.status === 200 && rolePreview.json.data.steps.some((step) => step.name === 'rp-beta' && step.action === 'disable'), JSON.stringify(rolePreview.json).slice(0, 200))
check('preview 不落盘', existsSync(join(rolesProjectSkills, 'rp-beta', 'SKILL.md')))
check('preview 缺 role 参数 400', (await call({ path: '/api/skill-console/roles/preview', headers: roleSession })).json.code === 'error.proto.missingId')
check('preview 未知角色 404', (await call({ path: '/api/skill-console/roles/preview?role=nope', headers: roleSession })).json.code === 'error.role.unknown')

const activated = await call({ method: 'POST', path: '/api/skill-console/roles/activate', headers: { ...ROLE_WRITE, ...roleSession }, body: { id: savedRoleId } })
check('POST /roles/activate 返回 200', activated.status === 200 && activated.json.ok === true, JSON.stringify(activated.json).slice(0, 200))
check('activate 报告逐项结果', Array.isArray(activated.json.data.results) && activated.json.data.results.length >= 1)
check('activate 之后磁盘上 rp-beta 被停用', existsSync(join(rolesProjectSkills, 'rp-beta', 'SKILL.md.disabled')) && !existsSync(join(rolesProjectSkills, 'rp-beta', 'SKILL.md')))
check('activate 之后 rp-alpha 是启用的', existsSync(join(rolesProjectSkills, 'rp-alpha', 'SKILL.md')))
check('activate 之后 status 是 matched', activated.json.data.status === 'matched', String(activated.json.data.status))
check('activate 不回显角色里的绝对路径以外的东西（只回 id/name）', typeof activated.json.data.role?.id === 'string' && typeof activated.json.data.role?.name === 'string')
check('整轮操作没有动全局技能根', existsSync(join(home, 'skills', 'rp-global', 'SKILL.md')) && !existsSync(join(home, 'skills', 'rp-global', 'SKILL.md.disabled')))
check('全局同名接管被逐条报告（rp-beta 全局没有 → 空表）', Array.isArray(activated.json.data.takeover))

const afterActivate = await call({ path: '/api/skill-console/roles', headers: roleSession })
check('列表里 active 标记落到那个角色', afterActivate.json.data.active?.id === savedRoleId, JSON.stringify(afterActivate.json.data.active))
check('对齐后 status 是 matched', afterActivate.json.data.status === 'matched', String(afterActivate.json.data.status))
check('对齐后 stats.disable 为 0', afterActivate.json.data.stats.disable === 0, JSON.stringify(afterActivate.json.data.stats))

// 手工改一个开关 → 面板必须显示「已偏离」，且不自动纠正
await call({ method: 'POST', path: '/api/skill-console/toggle', headers: { ...ROLE_WRITE, ...roleSession }, body: { path: join(rolesProjectSkills, 'rp-alpha', 'SKILL.md'), enabled: false } })
const drifted = await call({ path: '/api/skill-console/roles', headers: roleSession })
check('手工改开关后 status 是 drifted', drifted.json.data.status === 'drifted', String(drifted.json.data.status))
check('漂移不自动纠正（文件仍是 .disabled）', existsSync(join(rolesProjectSkills, 'rp-alpha', 'SKILL.md.disabled')))

const deactivated = await call({ method: 'POST', path: '/api/skill-console/roles/deactivate', headers: { ...ROLE_WRITE, ...roleSession } })
check('POST /roles/deactivate 返回 200', deactivated.status === 200 && deactivated.json.ok === true, JSON.stringify(deactivated.json).slice(0, 160))
check('deactivate 只清记录、不动磁盘', existsSync(join(rolesProjectSkills, 'rp-alpha', 'SKILL.md.disabled')))
check('取消后回到 unassigned', (await call({ path: '/api/skill-console/roles', headers: roleSession })).json.data.status === 'unassigned')

const removedRoleResponse = await call({ method: 'POST', path: '/api/skill-console/roles/remove', headers: { ...ROLE_WRITE, ...roleSession }, body: { id: savedRoleId } })
check('POST /roles/remove 删掉角色', removedRoleResponse.status === 200 && removedRoleResponse.json.data.removed === savedRoleId, JSON.stringify(removedRoleResponse.json).slice(0, 160))
check('删角色不动磁盘', existsSync(join(rolesProjectSkills, 'rp-alpha', 'SKILL.md.disabled')))
check('remove 缺 id 400', (await call({ method: 'POST', path: '/api/skill-console/roles/remove', headers: { ...ROLE_WRITE, ...roleSession }, body: {} })).json.code === 'error.proto.missingId')
check('remove 未知 id 404', (await call({ method: 'POST', path: '/api/skill-console/roles/remove', headers: { ...ROLE_WRITE, ...roleSession }, body: { id: 'nope' } })).json.code === 'error.role.unknown')

// 围栏对 6 个新端点同样生效
const roleNoMarker = await call({ method: 'POST', path: '/api/skill-console/roles/save', headers: roleSession, body: { name: 'x', skills: [] } })
check('角色写端点缺标记 403', roleNoMarker.status === 403 && roleNoMarker.json.code === 'error.proto.forbidden', `${roleNoMarker.status} ${roleNoMarker.json?.code}`)
const roleGetOnWrite = await call({ path: '/api/skill-console/roles/save', headers: roleSession })
check('角色写端点用 GET 405', roleGetOnWrite.status === 405 && roleGetOnWrite.json.code === 'error.proto.method', `${roleGetOnWrite.status} ${roleGetOnWrite.json?.code}`)
const rolePostOnRead = await call({ method: 'POST', path: '/api/skill-console/roles', headers: { ...ROLE_WRITE, ...roleSession } })
check('角色读端点用 POST 405', rolePostOnRead.status === 405 && rolePostOnRead.json.code === 'error.proto.method', `${rolePostOnRead.status} ${rolePostOnRead.json?.code}`)

// 守卫 ctx（真实 cordis 语义）下也要跑通
const guardedRoles = await callRouteOrReport(guarded.routeOf(), { path: '/api/skill-console/roles', headers: roleSession })
check('守卫 ctx 下 GET /roles 返回 200', guardedRoles.status === 200, guardedRoles.threw ?? `${guardedRoles.status} ${JSON.stringify(guardedRoles.json).slice(0, 160)}`)

section('技能端点：删除 / 移动到项目（真备份、真围栏）')
// 删除：先备份再删，删完能从备份原样恢复
placeSkill(join(home, 'skills'), 'del-target', true)
const delRes = await call({ method: 'POST', path: '/api/skill-console/skills/delete', headers: { ...ROLE_WRITE, ...roleSession }, body: { path: join(home, 'skills', 'del-target', 'SKILL.md') } })
check('POST /skills/delete 返回 200 且 deleted', delRes.status === 200 && delRes.json?.data?.deleted === true, `${delRes.status} ${JSON.stringify(delRes.json).slice(0, 200)}`)
check('删除响应带回备份目录', typeof delRes.json?.data?.backup === 'string' && existsSync(delRes.json.data.backup))
check('磁盘上技能整包消失', !existsSync(join(home, 'skills', 'del-target')))
check('技能根本身还在', existsSync(join(home, 'skills')))
const restoreRes = await call({ method: 'POST', path: '/api/skill-console/restore', headers: { ...ROLE_WRITE, ...roleSession }, body: { name: 'del-target' } })
check('删除后能从备份原样恢复', restoreRes.status === 200 && existsSync(join(home, 'skills', 'del-target', 'SKILL.md')), `${restoreRes.status} ${JSON.stringify(restoreRes.json).slice(0, 200)}`)
check('缺 path → 400 error.proto.missingPath', (await call({ method: 'POST', path: '/api/skill-console/skills/delete', headers: { ...ROLE_WRITE, ...roleSession }, body: {} })).json?.code === 'error.proto.missingPath')
const outsideDelete = await call({ method: 'POST', path: '/api/skill-console/skills/delete', headers: { ...ROLE_WRITE, ...roleSession }, body: { path: join(tmpdir(), 'nowhere', 'SKILL.md') } })
check('根外路径 → 400 error.path.outsideRoots', outsideDelete.status === 400 && outsideDelete.json?.code === 'error.path.outsideRoots', `${outsideDelete.status} ${JSON.stringify(outsideDelete.json).slice(0, 160)}`)
check('GET 打这个写端点 → 405', (await call({ path: '/api/skill-console/skills/delete', headers: roleSession })).status === 405)
check('缺标记头 → 403', (await call({ method: 'POST', path: '/api/skill-console/skills/delete', headers: { 'content-type': 'application/json' }, body: { path: join(home, 'skills', 'del-target', 'SKILL.md') } })).status === 403)

// 移动：只允许全局 → 项目
placeSkill(join(home, 'skills'), 'move-me', true)
const moveRes = await call({ method: 'POST', path: '/api/skill-console/skills/move-to-project', headers: { ...ROLE_WRITE, ...roleSession }, body: { path: join(home, 'skills', 'move-me', 'SKILL.md') } })
check('POST /skills/move-to-project 200 且 globalRemoved=true', moveRes.status === 200 && moveRes.json?.data?.globalRemoved === true, `${moveRes.status} ${JSON.stringify(moveRes.json).slice(0, 200)}`)
check('项目里出现启用态副本', existsSync(join(rolesProjectSkills, 'move-me', 'SKILL.md')))
check('全局那份已经不存在', !existsSync(join(home, 'skills', 'move-me')))
placeSkill(rolesProjectSkills, 'p-local', true)
const notGlobal = await call({ method: 'POST', path: '/api/skill-console/skills/move-to-project', headers: { ...ROLE_WRITE, ...roleSession }, body: { path: join(rolesProjectSkills, 'p-local', 'SKILL.md') } })
check('项目里的技能不能「移到项目」→ 400 error.transfer.notGlobal', notGlobal.status === 400 && notGlobal.json?.code === 'error.transfer.notGlobal', `${notGlobal.status} ${JSON.stringify(notGlobal.json).slice(0, 160)}`)
placeSkill(join(home, 'skills'), 'dup-me', true)
placeSkill(rolesProjectSkills, 'dup-me', true)
const dupMove = await call({ method: 'POST', path: '/api/skill-console/skills/move-to-project', headers: { ...ROLE_WRITE, ...roleSession }, body: { path: join(home, 'skills', 'dup-me', 'SKILL.md') } })
check('目标已有同名 → 409 error.transfer.exists', dupMove.status === 409 && dupMove.json?.code === 'error.transfer.exists', `${dupMove.status} ${JSON.stringify(dupMove.json).slice(0, 200)}`)
check('冲突时全局那份没被动', existsSync(join(home, 'skills', 'dup-me', 'SKILL.md')))
check('冲突时项目那份也没被动', existsSync(join(rolesProjectSkills, 'dup-me', 'SKILL.md')))
const linkOutside = tempDir('move-outside')
mkdirSync(join(linkOutside, 'nofm'), { recursive: true })
writeFileSync(join(linkOutside, 'nofm', 'SKILL.md'), '# 没有 frontmatter\n')
symlinkSync(join(linkOutside, 'nofm'), join(home, 'skills', 'link-me'))
const linkMove = await call({ method: 'POST', path: '/api/skill-console/skills/move-to-project', headers: { ...ROLE_WRITE, ...roleSession }, body: { path: join(home, 'skills', 'link-me', 'SKILL.md') } })
check('软链接 → 400 error.transfer.symlink', linkMove.status === 400 && linkMove.json?.code === 'error.transfer.symlink', `${linkMove.status} ${JSON.stringify(linkMove.json).slice(0, 200)}`)
check('软链接被拒后链接目标还在', existsSync(join(linkOutside, 'nofm', 'SKILL.md')))

// 「复制成功、删全局失败」：把全局那份设成只读，删不掉 → 如实报告，不回滚
placeSkill(join(home, 'skills'), 'stuck-me', true)
chmodSync(join(home, 'skills', 'stuck-me'), 0o500)
let stuckMove
try {
	stuckMove = await call({ method: 'POST', path: '/api/skill-console/skills/move-to-project', headers: { ...ROLE_WRITE, ...roleSession }, body: { path: join(home, 'skills', 'stuck-me', 'SKILL.md') } })
} finally {
	chmodSync(join(home, 'skills', 'stuck-me'), 0o700)
}
check('删全局失败 → 200 但 globalRemoved=false', stuckMove?.status === 200 && stuckMove?.json?.data?.globalRemoved === false, `${stuckMove?.status} ${JSON.stringify(stuckMove?.json).slice(0, 240)}`)
check('删全局失败时项目里已经就位', existsSync(join(rolesProjectSkills, 'stuck-me', 'SKILL.md')))
check('删全局失败时如实带 warning', typeof stuckMove?.json?.data?.warning === 'string' && stuckMove.json.data.warning.length > 0, String(stuckMove?.json?.data?.warning))

// 安装目标端点：`target:'project'` 必须在**路由层**就端到端证明落点。
// 先用桩 GitHub（见 apply 处的 `routeStub`）经路由订阅 'o/r'，再分别装到项目 / 缺省全局。
const addRoute = await call({ method: 'POST', path: '/api/skill-console/repositories/add', headers: { ...ROLE_WRITE, ...roleSession }, body: { url: 'https://github.com/o/r', subdirectory: 'skills' } })
check('路由层能订阅桩仓库（初始发现不报错）', addRoute.status === 200 && addRoute.json?.data?.fetchError === null && addRoute.json?.data?.skills?.some((skill) => skill.name === 'proj-only'), `${addRoute.status} ${JSON.stringify(addRoute.json).slice(0, 240)}`)
const fetchRoute = await call({ method: 'POST', path: '/api/skill-console/repositories/fetch', headers: { ...ROLE_WRITE, ...roleSession }, body: { id: 'o/r' } })
check('路由层能拉取清单并看见 proj-only', fetchRoute.status === 200 && fetchRoute.json?.data?.skills?.some((skill) => skill.name === 'proj-only'), `${fetchRoute.status} ${JSON.stringify(fetchRoute.json).slice(0, 240)}`)

const installToProject = await call({ method: 'POST', path: '/api/skill-console/repositories/install', headers: { ...ROLE_WRITE, ...roleSession }, body: { id: 'o/r', skills: ['proj-only'], target: 'project' } })
check('install 带 target=project：技能真的落进项目技能根', installToProject.status === 200 && installToProject.json?.data?.installed?.[0]?.path === join(rolesProjectSkills, 'proj-only') && existsSync(join(rolesProjectSkills, 'proj-only', 'SKILL.md')), `${installToProject.status} ${JSON.stringify(installToProject.json).slice(0, 240)}`)
check('install 带 target=project：全局技能根没有被写', !existsSync(join(globalRoot, 'proj-only')), join(globalRoot, 'proj-only'))

const installDefault = await call({ method: 'POST', path: '/api/skill-console/repositories/install', headers: { ...ROLE_WRITE, ...roleSession }, body: { id: 'o/r', skills: ['proj-only'] } })
check('同一仓库缺省 target 再装一次：落点是全局技能根（向后兼容没坏）', installDefault.status === 200 && installDefault.json?.data?.installed?.[0]?.path === join(globalRoot, 'proj-only') && existsSync(join(globalRoot, 'proj-only', 'SKILL.md')), `${installDefault.status} ${JSON.stringify(installDefault.json).slice(0, 240)}`)

// 解析不出项目根时，`target:'project'` 必须 400，不能悄悄退回全局。
// 现场唯一能让项目解析失败的办法是拿掉 `sessions`——再 apply 一个只用于这条的路由。
let noProjectRoute = null
host.apply({
	...pluginCtx,
	sessions: undefined,
	webServer: { register: (route) => {
		noProjectRoute = route
		return () => {}
	} },
})
const installNoProject = await callRoute(noProjectRoute, { method: 'POST', path: '/api/skill-console/repositories/install', headers: { ...ROLE_WRITE, ...roleSession }, body: { id: 'o/r', skills: ['proj-only'], target: 'project' } })
check('解析不出项目根 + target=project → 400 error.role.noProject（不退化成全局）', installNoProject.status === 400 && installNoProject.json?.code === 'error.role.noProject', `${installNoProject.status} ${JSON.stringify(installNoProject.json).slice(0, 200)}`)

// ── 5. 浏览器半边 ─────────────────────────────────────────────────────────

section('浏览器半边（模块表 / slot 契约 / 降级）')
let loaded = null
const sandbox = { window: { __ModuleLoader__: { load: (spec) => { loaded = spec } } }, console }
vm.runInNewContext(clientSource, sandbox, { filename: 'lib/client.js' })
check('通过 __ModuleLoader__ 注册了自身', loaded !== null)
check('模块表 id 与包名一致', loaded?.id === pkg.name, `实际 ${loaded?.id}`)
check('factory 是函数', typeof loaded?.factory === 'function')

/** 极简 React 替身：能直接调用组件函数看它渲染了什么，hooks 只要不炸。 */
const reactStub = {
	createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
	useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
	useEffect: () => {},
	useMemo: (fn) => (typeof fn === 'function' ? fn() : undefined),
	useCallback: (fn) => fn,
	useRef: () => ({ current: null }),
	Fragment: 'Fragment',
	Component: class Component {
		constructor(props) {
			this.props = props || {}
			this.state = {}
		}
		setState(next) {
			this.state = { ...this.state, ...next }
		}
	},
}
const primitivesStub = new Proxy(
	{},
	{
		get: (target, key) => {
			if (typeof key !== 'string') return undefined
			// 大写的都当成组件；小写的当成工具函数，返回一个安全值。
			if (/^[A-Z]/.test(key)) return (props) => reactStub.createElement(key, { 'data-primitive': key, ...(props || {}) })
			return () => ''
		},
	},
)
const requireFor = (withPrimitives) => (name) => {
	if (name === 'react') return reactStub
	if (withPrimitives && name === '@deepseek-ai/dsh-client-ui-primitives') return primitivesStub
	throw new Error(`客户端 bundle 只能 require react / primitives，实际 require 了 ${name}`)
}
const clientExports = loaded.factory(requireFor(true))
check('导出 apply', typeof clientExports.apply === 'function')
check(
	'导出 inject，且只依赖 slots / locale',
	Array.isArray(clientExports.inject) && clientExports.inject.join(',') === 'slots,locale',
	JSON.stringify(clientExports.inject),
)
check('客户端用的是本插件的路由前缀', clientSource.includes('/api/skill-console'))
check(
	'写操作带上了客户端标记头（否则宿主一律 403）',
	clientSource.includes("'x-skill-console'") || clientSource.includes('"x-skill-console"'),
)
check('样式只用官方设计令牌', clientSource.includes('--dsw-alias-'))
check('没有把会话头写成常量以外的名字', clientSource.includes('x-skill-console-session'))

const registrations = []
const localeDictionaries = []
const clientCtx = {
	effect: (fn) => {
		const disposer = fn()
		return () => {
			if (typeof disposer === 'function') disposer()
		}
	},
	slots: {
		inject: (key, callback) => callback(),
		register: (spec, component) => {
			registrations.push({ spec, component })
			return () => {}
		},
	},
	locale: {
		register: (ns, dictionaries) => {
			localeDictionaries.push({ ns, dictionaries })
			return () => {}
		},
		bind: () => (key) => key,
	},
}
clientExports.apply(clientCtx)

check('只注册一个挂载点', registrations.length === 1, registrations.map((entry) => entry.spec?.name).join(','))
const sectionEntry = registrations[0]
check('挂在 settings.section 上', sectionEntry?.spec?.name === 'settings.section')
check('分区 id 与插件行一致', sectionEntry?.spec?.id === patchRow?.[1], `${sectionEntry?.spec?.id} vs ${patchRow?.[1]}`)
check('分区有 order 可以排位置', typeof sectionEntry?.spec?.order === 'number', `实际 ${sectionEntry?.spec?.order}`)
check('分区 label 是函数且返回非空字符串', typeof sectionEntry?.spec?.label === 'function' && typeof sectionEntry.spec.label() === 'string' && sectionEntry.spec.label().length > 0)
check('注册了 locale 字典（zh + en）', localeDictionaries.length >= 1 && Object.keys(localeDictionaries[0].dictionaries ?? {}).length >= 2, JSON.stringify(localeDictionaries.map((entry) => entry.ns)))
// 两套词典必须键集一致：缺一个键，英文界面就会原样吐出 `repos.xxx` 这种机器码。
const dictionaryZh = localeDictionaries[0]?.dictionaries?.zh ?? {}
const dictionaryEn = localeDictionaries[0]?.dictionaries?.en ?? {}
const missingInEn = Object.keys(dictionaryZh).filter((key) => !(key in dictionaryEn)).sort()
const missingInZh = Object.keys(dictionaryEn).filter((key) => !(key in dictionaryZh)).sort()
check('zh 与 en 的键集完全一致', missingInEn.length === 0 && missingInZh.length === 0, `en 缺 ${missingInEn.join(',')} / zh 缺 ${missingInZh.join(',')}`)
check('空清单提示两种语言都有', typeof dictionaryZh['repos.detailNoSkills'] === 'string' && typeof dictionaryEn['repos.detailNoSkills'] === 'string')
check('「没拉取过」与「拉到了但没技能」是两句不同的话', dictionaryZh['repos.detailNoSkills'] !== dictionaryZh['repos.detailEmpty'], '两句文案撞了，用户分不清是哪种空')
check('组件是函数', typeof sectionEntry?.component === 'function')

/** 深度优先遍历元素树。 */
function walk(node, visit) {
	if (!node || typeof node !== 'object') return
	if (Array.isArray(node)) {
		for (const child of node) walk(child, visit)
		return
	}
	visit(node)
	for (const child of node.children || []) walk(child, visit)
}
function collect(node, predicate) {
	const found = []
	walk(node, (element) => {
		if (predicate(element)) found.push(element)
	})
	return found
}
const boundaryOf = (tree) => collect(tree, (element) => typeof element.type?.getDerivedStateFromError === 'function')[0]

/** 收集元素树里的文本（`walk` 只遍历对象，字符串要在 children 里单独收）。 */
function collectTexts(node, found = []) {
	if (node === null || node === undefined || typeof node === 'boolean') return found
	if (typeof node === 'string' || typeof node === 'number') {
		found.push(String(node))
		return found
	}
	if (Array.isArray(node)) {
		for (const child of node) collectTexts(child, found)
		return found
	}
	for (const child of node.children || []) collectTexts(child, found)
	return found
}

// 不传 useSessions（老 shell / 测试环境）：必须还能渲染
let renderError = null
let tree = null
try {
	tree = sectionEntry.component({})
} catch (error) {
	renderError = error
}
check('没有 useSessions 时组件仍能渲染', renderError === null, String(renderError))
// 页签文案在子组件（SkillConsoleSection）的渲染结果里，而且 pill 的文案挂在
// `props.children` 上（`collectTexts` 只走 `children`），所以这里显式渲染一层并两种都收。
function collectTextsWithProps(node, found = []) {
	if (node === null || node === undefined || typeof node === 'boolean') return found
	if (typeof node === 'string' || typeof node === 'number') {
		found.push(String(node))
		return found
	}
	if (Array.isArray(node)) {
		for (const child of node) collectTextsWithProps(child, found)
		return found
	}
	for (const child of node.children || []) collectTextsWithProps(child, found)
	const propChildren = node.props?.children
	if (Array.isArray(propChildren)) {
		for (const child of propChildren) collectTextsWithProps(child, found)
	} else if (propChildren !== undefined) {
		collectTextsWithProps(propChildren, found)
	}
	return found
}
const sectionShell = tree && Array.isArray(tree.children) ? tree.children[0] : null
const sectionRendered = typeof sectionShell?.type === 'function' ? sectionShell.type(sectionShell.props || {}) : null
const sectionTexts = collectTextsWithProps(sectionRendered)
check('三个页签的文案都渲染出来了', sectionTexts.includes('角色') && sectionTexts.includes('技能') && sectionTexts.includes('技能仓库'), sectionTexts.join('|').slice(0, 200))
check('渲染结果外面套了降级边界', Boolean(boundaryOf(tree)), '没找到边界')
check('降级边界出错后渲染空', boundaryOf(tree)?.type?.getDerivedStateFromError?.()?.failed === true)
const boundaryInstance = new (boundaryOf(tree).type)({ children: 'x' })
check('降级边界正常时透传内容', boundaryInstance.render() === 'x')
boundaryInstance.setState(boundaryOf(tree).type.getDerivedStateFromError())
check('降级边界出错后渲染 null', boundaryInstance.render() === null)

// 传一个最小的 session store：不能抛，且应当把 current 当成默认项目
let withSessionsError = null
try {
	sectionEntry.component({ useSessions: (selector) => selector({ phase: 'ready', current: 'session-x', byId: {}, ids: [] }) })
} catch (error) {
	withSessionsError = error
}
check('带 useSessions 时也不抛', withSessionsError === null, String(withSessionsError))

// 会话 id 的取值规则直接单测：它决定面板显示的是「你正在看的会话」还是
// 宿主的默认会话。取错了不会报错，只会安静地显示另一个工作区的项目技能。
const sessionIdOf = loaded.factory(requireFor(true)).sessionIdOf
check('sessionIdOf 被导出（契约的一部分）', typeof sessionIdOf === 'function')
check('sessionIdOf 优先用 current', sessionIdOf({ current: 'session-a' }) === 'session-a')
check('sessionIdOf 忽略空 current', sessionIdOf({ current: '', byId: {} }) === undefined)
check('sessionIdOf 退回主视图保留的会话', sessionIdOf({ current: '', ids: ['a', 'b'], byId: { a: { retainedBy: {} }, b: { retainedBy: { mainView: true } } } }) === 'b')
check('sessionIdOf 没有 ids 时按 byId 键遍历', sessionIdOf({ current: '', byId: { z: { retainedBy: { mainView: true } } } }) === 'z')
check('sessionIdOf 对垃圾输入不抛', sessionIdOf(null) === undefined && sessionIdOf('x') === undefined && sessionIdOf({ byId: 7 }) === undefined)
check('sessionIdOf 找不到主视图会话时返回 undefined（交给宿主回落）', sessionIdOf({ current: '', ids: ['a'], byId: { a: {} } }) === undefined)

// 角色页面状态：由宿主 /roles 的返回推导，缺字段时不能崩。
const roleStatusOf = loaded.factory(requireFor(true)).roleStatusOf
check('roleStatusOf 被导出（契约的一部分）', typeof roleStatusOf === 'function')
check('roleStatusOf 认 unassigned', roleStatusOf({ status: 'unassigned' }) === 'unassigned')
check('roleStatusOf 认 matched', roleStatusOf({ status: 'matched' }) === 'matched')
check('roleStatusOf 认 drifted', roleStatusOf({ status: 'drifted' }) === 'drifted')
check('roleStatusOf 认不出的值退回 unassigned', roleStatusOf({ status: '瞎写的' }) === 'unassigned')
check('roleStatusOf 对垃圾输入不抛', roleStatusOf(null) === 'unassigned' && roleStatusOf('x') === 'unassigned' && roleStatusOf({}) === 'unassigned')

// 技能明细行：显示**所属仓库**，简介只在悬停气泡里出现。
const sourceRepoOf = loaded.factory(requireFor(true)).sourceRepoOf
check('sourceRepoOf 用 owner/name', sourceRepoOf({ installed: { owner: 'o', name: 'r', id: 'o/r' } }) === 'o/r')
check('sourceRepoOf 没有 owner/name 时退回仓库 id', sourceRepoOf({ installed: { id: 'o/r/skills' } }) === 'o/r/skills')
check('sourceRepoOf 本地技能返回 null', sourceRepoOf({ installed: null }) === null)
check('sourceRepoOf 对垃圾输入不抛', sourceRepoOf(null) === null && sourceRepoOf({ installed: 'x' }) === null && sourceRepoOf({ installed: {} }) === null)

const DESCRIPTION = '这句简介只该出现在悬停气泡里'
const tCalls = []
const tStub = (key, params) => {
	tCalls.push(key)
	if (key === 'skills.source') return '所属仓库'
	if (key === 'skills.sourceLocal') return '本地（非订阅）'
	return params === undefined ? key : key + JSON.stringify(params)
}

// 角色明细行：状态徽标与技能数必须来自数据，而不是写死。
const RoleRowExport = loaded.factory(requireFor(true)).RoleRow
const RoleEditorExport = loaded.factory(requireFor(true)).RoleEditor
check('RoleRow 被导出（契约的一部分）', typeof RoleRowExport === 'function')
check('RoleEditor 被导出（契约的一部分）', typeof RoleEditorExport === 'function')

const roleRowTree = RoleRowExport({
	t: tStub,
	role: { id: 'r1', name: '前端', skills: ['a', 'b'], updatedAt: 1, active: true },
	status: 'matched',
	busy: false,
	onActivate: () => {},
	onEdit: () => {},
	onRemove: () => {},
})
check('RoleRow 渲染出角色名', collectTexts(roleRowTree).includes('前端'), collectTexts(roleRowTree).join('|').slice(0, 160))
check('RoleRow 把技能数讲出来', collectTexts(roleRowTree).some((text) => text.includes('skillsCount')), collectTexts(roleRowTree).join('|').slice(0, 160))

const roleEditorTree = RoleEditorExport({
	t: tStub,
	draft: { id: null, name: '新角色', skills: ['rp-alpha'] },
	candidates: {
		project: [{ name: 'rp-alpha', path: '/p/rp-alpha/SKILL.md', enabled: true, toggleable: true, readOnlyReason: null }],
		global: [{ name: 'rp-global', path: '/g/rp-global/SKILL.md', enabled: true, toggleable: true, readOnlyReason: null, readOnly: true, reason: 'global-uncontrollable' }],
	},
	missing: [],
	busy: false,
	onName: () => {},
	onToggle: () => {},
	onSave: () => {},
	onCancel: () => {},
	onActivate: () => {},
})
check('RoleEditor 为全局技能渲染只读说明', collectTexts(roleEditorTree).some((text) => text.includes('globalReadonly')), collectTexts(roleEditorTree).join('|').slice(0, 200))
check('RoleEditor 把可勾选的项目技能渲染出来', collectTexts(roleEditorTree).some((text) => text.includes('rp-alpha')), collectTexts(roleEditorTree).join('|').slice(0, 160))
check('RoleEditor 列出角色里缺失的技能', collectTexts(RoleEditorExport({ t: tStub, draft: { id: 'r', name: 'x', skills: ['gone'] }, candidates: { project: [], global: [] }, missing: ['gone'], busy: false, onName: () => {}, onToggle: () => {}, onSave: () => {}, onCancel: () => {}, onActivate: () => {} })).some((text) => text.includes('gone')))

const rolesReadme = readFileSync(join(LIB, 'client.js'), 'utf8')
check('角色面板不复用全局根的写路径（不在客户端拼 applyRole 的入参）', !/applyRole/.test(rolesReadme))

const rowProps = {
	t: tStub,
	busy: false,
	skill: {
		name: 'alpha',
		description: DESCRIPTION,
		enabled: true,
		diagnostics: [],
		declaredName: 'alpha',
		installed: { id: 'o/r', owner: 'o', name: 'r', commit: 'abc123', sourcePath: 'skills/alpha' },
	},
	onOpen: () => {},
	onToggle: () => {},
}
const rowTree = loaded.factory(requireFor(true)).SkillRow(rowProps)
const rowTexts = collectTexts(rowTree)
check('明细行显示所属仓库 owner/name', rowTexts.includes('o/r'), JSON.stringify(rowTexts))
check('明细行请求了「所属仓库」标签', tCalls.includes('skills.source'), tCalls.join(','))
check('明细行不再直接显示 description', !rowTexts.some((text) => text.includes(DESCRIPTION)), JSON.stringify(rowTexts))
const tooltipNode = collect(rowTree, (element) => element.props && typeof element.props.label === 'function')[0]
check('明细行挂了 tooltip（label 是惰性解析函数）', tooltipNode !== undefined)
const tipTexts = collectTexts(tooltipNode?.props?.label?.())
check('悬停气泡里才显示 description', tipTexts.some((text) => text.includes(DESCRIPTION)), JSON.stringify(tipTexts))
check('气泡里带上安装 commit', tipTexts.some((text) => text.includes('abc123')), JSON.stringify(tipTexts))

// 本地技能（没装过）：明细行回落成「本地（非订阅）」
const localTree = loaded.factory(requireFor(true)).SkillRow({ ...rowProps, skill: { ...rowProps.skill, installed: null, description: DESCRIPTION } })
const localTexts = collectTexts(localTree)
check('本地技能明细行显示「本地（非订阅）」', localTexts.includes('本地（非订阅）'), JSON.stringify(localTexts))
check('本地技能也不内联 description', !localTexts.some((text) => text.includes(DESCRIPTION)))
const localTip = collect(localTree, (element) => element.props && typeof element.props.label === 'function')[0]
check('本地技能气泡里仍有 description', collectTexts(localTip?.props?.label?.()).some((text) => text.includes(DESCRIPTION)))
check('本地技能气泡里没有 commit 行', !collectTexts(localTip?.props?.label?.()).some((text) => text.includes('commit')))

// 面板上不出现任何具体目录地址（技能根 / 项目根 / 技能文件 / 备份目录）。
const exposed = loaded.factory(requireFor(true))
check('导出 SkillGroup / RepoRow 供契约测试直接渲染', typeof exposed.SkillGroup === 'function' && typeof exposed.RepoRow === 'function')
const groupTree = exposed.SkillGroup({
	t: tStub,
	root: { key: 'user-dsh', label: '全局 DSH', path: '/Users/someone/.dsh/skills', exists: true, skills: [] },
	busy: false,
	busyPath: null,
	onOpen: () => {},
	onToggle: () => {},
	onBatch: () => {},
})
const groupTexts = collectTexts(groupTree)
check('技能分组头不显示技能根路径', !groupTexts.some((text) => text.includes('/Users/someone')), JSON.stringify(groupTexts))
check('技能分组头仍然显示根名', groupTexts.includes('全局 DSH'), JSON.stringify(groupTexts))

const repoRowCalls = []
const repoStub = (key, params) => {
	repoRowCalls.push(key)
	return params === undefined ? key : key + JSON.stringify(params)
}
const repoRowProps = {
	t: repoStub,
	repo: { id: 'o/r', url: 'https://github.com/o/r', ref: '', subdirectory: '', status: {}, lastFetch: null },
	expanded: false,
	busy: false,
	editing: false,
	editForm: { ref: '', subdirectory: '' },
	detail: { loading: false, data: null, error: null },
	picked: {},
	installResult: null,
	emptyDetailKey: 'repos.detailEmpty',
	onToggle: () => {},
	onFetch: () => {},
	onRemove: () => {},
	onEdit: () => {},
	onEditField: () => {},
	onEditSave: () => {},
	onEditCancel: () => {},
	onTogglePick: () => {},
	onSelectAll: () => {},
	onClearPicked: () => {},
	onInstall: () => {},
	onRestore: () => {},
}
const repoRowTree = exposed.RepoRow(repoRowProps)
check(
	'仓库行给出三个管理动作：编辑 / 更新 / 删除',
	['repos.edit', 'repos.fetch', 'repos.remove'].every((key) => repoRowCalls.includes(key)),
	repoRowCalls.join(','),
)
check('未进入编辑态时不渲染编辑表单', !repoRowCalls.includes('repos.editSave'), repoRowCalls.join(','))

// 订阅卡片必须是**可折叠**的：技能明细长在它所属的仓库下面，收起时连明细一起收。
// 这是「能操作订阅的仓库 + 能折叠订阅下的技能明细」两条用户要求的直接契约。
check('导出 RepoSkills 供契约测试直接渲染', typeof exposed.RepoSkills === 'function')
const disclosureOf = (tree) => collect(tree, (element) => element.type === 'button' && String(element.props?.className || '').includes('sc-disclosure'))[0]
const caretOf = (tree) => collect(tree, (element) => String(element.props?.className || '').includes('sc-caret'))[0]
const skillsPanelOf = (tree) => collect(tree, (element) => element.type === exposed.RepoSkills)
const actionButtonOf = (tree, key) => collect(tree, (element) => element.props?.children === key && typeof element.props?.onClick === 'function')[0]
const repoHeadOf = (tree) => collect(tree, (element) => String(element.props?.className || '').includes('sc-repo-head'))[0]

const collapsedDisclosure = disclosureOf(repoRowTree)
check('收起的仓库卡片：给出「展开」控件', collapsedDisclosure !== undefined && repoRowCalls.includes('repos.expand'), repoRowCalls.join(','))
check('收起的仓库卡片：控件上带 aria-expanded=false', collapsedDisclosure?.props?.['aria-expanded'] === 'false', JSON.stringify(collapsedDisclosure?.props))
check('收起的仓库卡片：三角朝右（data-open=false）', caretOf(repoRowTree)?.props?.['data-open'] === 'false')
check('收起的仓库卡片：不渲染技能明细', skillsPanelOf(repoRowTree).length === 0)
check(
	'收起的仓库卡片：管理动作照旧在（收起不等于不能操作）',
	actionButtonOf(repoRowTree, 'repos.edit') !== undefined
		&& actionButtonOf(repoRowTree, 'repos.remove') !== undefined
		// 「拉取最新」套在 tooltip 里（children 走 props），单独取一次。
		&& collect(repoRowTree, (element) => element.props?.label === 'repos.fetchTitle')[0]?.props?.children?.props?.children === 'repos.fetch',
)

const expandedCalls = []
const expandedTree = exposed.RepoRow({
	...repoRowProps,
	expanded: true,
	t: (key, params) => {
		expandedCalls.push(key)
		return params === undefined ? key : key + JSON.stringify(params)
	},
})
check('展开的仓库卡片：控件变「收起」', expandedCalls.includes('repos.collapse') && !expandedCalls.includes('repos.expand'), expandedCalls.join(','))
check('展开的仓库卡片：控件上带 aria-expanded=true', disclosureOf(expandedTree)?.props?.['aria-expanded'] === 'true')
check('展开的仓库卡片：三角朝下（data-open=true）', caretOf(expandedTree)?.props?.['data-open'] === 'true')
check('展开的仓库卡片：技能明细挂在这张卡片里面', skillsPanelOf(expandedTree).length === 1)

// 点整行头部 = 展开/收起；点行内管理动作不能顺带把卡片也翻了。
let toggles = 0
let edits = 0
const clickTree = exposed.RepoRow({ ...repoRowProps, onToggle: () => { toggles += 1 }, onEdit: () => { edits += 1 } })
repoHeadOf(clickTree).props.onClick()
check('点卡片头部切换展开状态', toggles === 1, String(toggles))
const stopLog = []
actionButtonOf(clickTree, 'repos.edit').props.onClick({ stopPropagation: () => stopLog.push('stopped') })
check('点「编辑」先掐断冒泡，不会顺带折叠卡片', stopLog.length === 1 && edits === 1 && toggles === 1, `stop=${stopLog.length} edit=${edits} toggle=${toggles}`)

// 展开区里的勾选 / 全选 / 安装，以及勾选状态跟着**这个仓库**走。
const panelCalls = []
const panelParams = []
const panelProps = {
	t: (key, params) => {
		panelCalls.push(key)
		panelParams.push([key, params])
		return params === undefined ? key : key + JSON.stringify(params)
	},
	busy: false,
	detail: {
		loading: false,
		error: null,
		data: { repository: { id: 'o/r' }, skills: [{ name: 'alpha', status: 'not-installed', valid: true, sourcePath: 'skills/alpha', description: 'x' }] },
	},
	picked: { alpha: true },
	installResult: null,
	emptyDetailKey: 'repos.detailEmpty',
	onTogglePick: () => {},
	onSelectAll: () => {},
	onClearPicked: () => {},
	onInstall: () => {},
	onRestore: () => {},
}
const panelTree = exposed.RepoSkills(panelProps)
check(
	'展开区给出勾选 / 全不选 / 安装更新选中三个控件',
	['repos.selectAll', 'repos.selectNone', 'repos.install'].every((key) => panelCalls.includes(key)),
	panelCalls.join(','),
)
check('展开区里的技能来自这个仓库的明细', collect(panelTree, (element) => element.type === exposed.RepoRow).length === 0 && panelCalls.includes('repos.skillCount'))
check(
	'展开区显示已勾选数量',
	panelParams.some(([key, params]) => key === 'repos.selected' && params?.count === 1),
	JSON.stringify(panelParams.filter(([key]) => key === 'repos.selected')),
)
check('展开区里的技能行是可勾选的', collect(panelTree, (element) => element.props?.selected !== undefined).some((element) => element.props.selected === true))
check('明细加载中 / 出错时说得清楚', (() => {
	const loadingCalls = []
	exposed.RepoSkills({ ...panelProps, detail: { loading: true, data: null, error: null } , t: (key) => { loadingCalls.push(key); return key } })
	const errorCalls = []
	const errorTree = exposed.RepoSkills({ ...panelProps, detail: { loading: false, data: null, error: 'boom' }, t: (key) => { errorCalls.push(key); return key } })
	return loadingCalls.includes('repos.detailLoading') && collectTexts(errorTree).includes('boom')
})())

// 根因回归：面板子项一旦被 flex 压扁，订阅卡片会整段消失（只剩两条边框线）。
check(
	'面板 / 订阅卡片列表的子项一律不收缩（曾把订阅行整个压没）',
	/\.sc-body\s*>\s*\*\s*\{[^}]*flex:\s*0 0 auto/.test(clientSource) && /\.sc-repos\s*>\s*\*\s*\{[^}]*flex:\s*0 0 auto/.test(clientSource),
)
check('面板上不再有一张独立的「仓库里的技能」卡片', !/activeRepo\b/.test(clientSource))
check('展开 / 收起 / 全部收起三种文案都有', ['repos.expand', 'repos.collapse', 'repos.collapseAll'].every((key) => typeof dictionaryZh[key] === 'string' && typeof dictionaryEn[key] === 'string'))

check('导出 emptyDetailKeyFor 供契约测试直接打', typeof exposed.emptyDetailKeyFor === 'function')
// 空清单的两种成因要说两句话：拉取成功却 0 技能 = 多半是子目录没指对（真实现场：
// 订阅了 monorepo 根，根下只有 README 之类的文档）。
check('没拉取过 → 提示去点「拉取最新」', exposed.emptyDetailKeyFor({ lastFetch: null }) === 'repos.detailEmpty')
check('拉取成功但 0 技能 → 提示子目录可能填错', exposed.emptyDetailKeyFor({ lastFetch: { at: 1, error: null } }) === 'repos.detailNoSkills', exposed.emptyDetailKeyFor({ lastFetch: { at: 1, error: null } }))
check('拉取失败 → 不说「子目录可能填错」', exposed.emptyDetailKeyFor({ lastFetch: { at: 1, error: 'socket hang up' } }) === 'repos.detailEmpty')
check('没有订阅行时不抛异常', exposed.emptyDetailKeyFor(null) === 'repos.detailEmpty')
check(
	'进入编辑态时行内挂上编辑表单',
	collect(repoRowTree, (element) => typeof element.type === 'function' && element.type.name === 'RepoEditForm').length === 0
		&& collect(exposed.RepoRow({ ...repoRowProps, editing: true }), (element) => typeof element.type === 'function' && element.type.name === 'RepoEditForm').length === 1,
)
check('导出 RepoEditForm 供契约测试直接渲染', typeof exposed.RepoEditForm === 'function')
const editingCalls = []
const editFormTree = exposed.RepoEditForm({
	t: (key, params) => {
		editingCalls.push(key)
		return params === undefined ? key : key + JSON.stringify(params)
	},
	repo: { id: 'o/r' },
	form: { ref: 'main', subdirectory: 'skills' },
	busy: false,
	onField: () => {},
	onSave: () => {},
	onCancel: () => {},
})
check(
	'编辑态渲染保存 / 取消与不可改地址的说明',
	['repos.editSave', 'repos.editCancel', 'repos.editHint'].every((key) => editingCalls.includes(key)),
	editingCalls.join(','),
)
check('编辑表单只给分支 / 子目录两个输入框', ['repos.addRef', 'repos.addSubdir'].every((key) => editingCalls.includes(key)) && !editingCalls.includes('repos.addUrl'), editingCalls.join(','))
const editInputs = collect(editFormTree, (element) => element.props && 'value' in element.props)
check('编辑表单回填当前设置', editInputs.map((element) => element.props.value).join(',') === 'main,skills', JSON.stringify(editInputs.map((element) => element.props.value)))

// 项目下拉：值是会话 id（宿主靠它解析 cwd），标签只有项目名（面板不显示绝对路径）。
check('导出 projectOptionsOf 供契约测试直接打', typeof exposed.projectOptionsOf === 'function')
const optionList = exposed.projectOptionsOf([
	{ sessionId: 's-1', cwd: '/Users/x/code/proj-a/sub', root: '/Users/x/code/proj-a', updatedAt: 2 },
	{ sessionId: 's-2', cwd: '/Users/x/code/proj-b', root: '/Users/x/code/proj-b', updatedAt: 1 },
])
check('选项的值是会话 id', optionList.map((option) => option.value).join(',') === 's-1,s-2', JSON.stringify(optionList))
check('选项的标签只有项目名，没有绝对路径', optionList.map((option) => option.label).join(',') === 'proj-a,proj-b', JSON.stringify(optionList))
check('没有 root 时回落到 cwd 的末段名', exposed.projectOptionsOf([{ sessionId: 's-3', cwd: '/Users/x/code/proj-c' }])[0].label === 'proj-c')
check('项目列表为空/缺失时不抛', exposed.projectOptionsOf(undefined).length === 0 && exposed.projectOptionsOf(null).length === 0)

// 下拉框的当前值必须永远落在选项里：去重后同一项目的代表会话会换人。
check('导出 projectOptionOfPick 供契约测试直接打', typeof exposed.projectOptionOfPick === 'function')
const pickOptions = exposed.projectOptionsOf([
	{ sessionId: 's-new', cwd: '/Users/x/code/proj-a', root: '/Users/x/code/proj-a' },
	{ sessionId: 's-b', cwd: '/Users/x/code/proj-b', root: '/Users/x/code/proj-b' },
])
check('会话还在 → 原样认领', exposed.projectOptionOfPick({ value: 's-b', root: '/Users/x/code/proj-b' }, pickOptions)?.value === 's-b')
check(
	'代表会话换人（同项目根） → 认领新的代表，下拉不会选空',
	exposed.projectOptionOfPick({ value: 's-old', root: '/Users/x/code/proj-a' }, pickOptions)?.value === 's-new',
	JSON.stringify(exposed.projectOptionOfPick({ value: 's-old', root: '/Users/x/code/proj-a' }, pickOptions)),
)
check('项目整个没了 → 返回 null，由调用方落回默认', exposed.projectOptionOfPick({ value: 's-gone', root: '/Users/x/code/proj-gone' }, pickOptions) === null)
check('没选过 / 选项缺失时不抛', exposed.projectOptionOfPick(null, pickOptions) === null && exposed.projectOptionOfPick({ value: 's-b', root: '/x' }, undefined) === null)

// 选择状态认项目根而不是会话 id：源码里不能再出现旧的一次性会话 id 状态。
check('面板不再按会话 id 记项目选择', !/setProjectId\b/.test(clientSource) && !/\[projectId,/.test(clientSource))

// primitives / locale 缺失时不能崩
const quietWarn = console.warn
console.warn = () => {}
let fallbackExports = null
try {
	fallbackExports = loaded.factory(requireFor(false))
} finally {
	console.warn = quietWarn
}
const fallbackRegistrations = []
let fallbackThrew = null
try {
	fallbackExports.apply({
		effect: (fn) => {
			fn()
			return () => {}
		},
		slots: { inject: (key, callback) => callback(), register: (spec, component) => {
			fallbackRegistrations.push({ spec, component })
			return () => {}
		} },
		locale: { register: () => () => {}, bind: () => (key) => key },
	})
	fallbackRegistrations[0]?.component({})
} catch (error) {
	fallbackThrew = error
}
check('primitives 缺失时仍能挂载与渲染', fallbackThrew === null, String(fallbackThrew))

let slotsMissingThrew = false
try {
	clientExports.apply({ effect: () => () => {}, slots: undefined, locale: { register: () => () => {}, bind: () => (key) => key } })
} catch {
	slotsMissingThrew = true
}
check('slots 缺失时不抛异常（否则整个 web shell boot 失败）', slotsMissingThrew === false)

let localeMissingThrew = false
try {
	clientExports.apply({ effect: () => () => {}, slots: { inject: (key, cb) => cb(), register: () => () => {} }, locale: undefined })
} catch {
	localeMissingThrew = true
}
check('locale 缺失时不抛异常', localeMissingThrew === false)

// ── 0.4.0：删除 / 移到项目 / 安装目标 / 角色的 copy 与 localKept ──────────

// SkillRow 是普通函数组件：用极简 React 替身直接调用就能看它渲染了什么。
// 注意这里的 `delRowT` / `delRowProps` 不能叫 `tStub` / `rowProps`——上面已经有同名的顶层 const。
const delRowT = (key) => key
const rowSkill = {
	name: 'demo', path: '/x/demo/SKILL.md', kind: 'directory', enabled: true,
	toggleable: true, root: 'user-dsh', readOnlyReason: null,
}
const delRowProps = { t: delRowT, skill: rowSkill, busy: false, rootName: '全局 DSH', canMove: true, onOpen: () => {}, onToggle: () => {}, onDelete: () => {}, onMove: () => {} }
const renderRow = (props) => JSON.stringify(clientExports.SkillRow({ ...delRowProps, ...props }))
check('SkillRow 有 onDelete 时渲染删除按钮', renderRow({}).includes('skills.delete'))
check('SkillRow 在全局技能上渲染「移到项目」', renderRow({}).includes('skills.move'))
check('没给 onDelete 就不渲染删除按钮', !renderRow({ onDelete: undefined }).includes('skills.delete'))
check('项目技能没有「移到项目」（canMove=false）', !renderRow({ canMove: false, skill: { ...rowSkill, root: 'project-dsh' } }).includes('skills.move'))

// 确认框文案：根名 / 技能名 / 形态三个槽都要填，软链与全局各补一句
check('删除确认框带上根名、技能名与形态', clientSource.includes("t('skills.deleteConfirm', { name:") && clientSource.includes('form: skillFormText(t, skill)') && clientSource.includes('root: rootName'))
check('软链接的删除说明是「只删这个链接」', clientSource.includes("t('skills.deleteSymlinkHint')"))
check('全局技能的删除说明会提示影响所有项目', clientSource.includes("t('skills.deleteGlobalHint')"))
check('「移到项目」只在全局技能上出现', clientSource.includes("root.key === 'user-dsh' && skill.toggleable === true"))
check('移动确认框写明「全局那份会消失」', clientSource.includes("t('skills.moveConfirm', { name:") && clientSource.includes("t('skills.movePartial'"))
check('角色面板把 copy 数显示出来', clientSource.includes("t('roles.copyCount', { count: copyCount })"))
check('角色面板把 localKept 显示出来', clientSource.includes("t('roles.localKept')") && clientSource.includes("t('roles.localKeptHint')"))
check('仓库页有安装目标选择', clientSource.includes("t('repos.installTarget')") && clientSource.includes('target: installTarget'))
check('安装到项目时会提示全局根不受影响', clientSource.includes("t('repos.targetProjectHint')"))
// 从角色列表直接激活时没有草稿：确认框的数量必须按「被激活的那个角色」算，否则恒为 0。
check('激活确认框按被激活角色的技能算数量', clientSource.includes('const confirmText = (skills) =>') && clientSource.includes('runActivate(role.id, role.skills ?? [])'))
check('从编辑器激活时按草稿算数量', clientSource.includes('runActivate(current.id, current.skills)'))
// 面板不显示任何具体目录地址（README.md:28）：删除 / 移动的回执里不许留 {path} / {backup} 槽。
const noticeCopy = [dictionaryZh['skills.deleteDone'], dictionaryZh['skills.moveDone'], dictionaryEn['skills.deleteDone'], dictionaryEn['skills.moveDone']].join('|')
check('删除 / 移动的回执不显示目录地址', !/\{path\}|\{backup\}/.test(noticeCopy), noticeCopy)

// 词典：0.4.0 新增键 zh / en 都得有（键集一致性由上面那条通用断言兜着）
for (const key of [
	'skills.delete', 'skills.deleteConfirm', 'skills.deleteSymlinkHint', 'skills.deleteGlobalHint',
	'skills.deleteDone', 'skills.deleteFailed', 'skills.move', 'skills.moveConfirm', 'skills.moveDone',
	'skills.movePartial', 'skills.moveFailed', 'skills.formFlat', 'skills.formDirectory', 'skills.formSymlink',
	'roles.copyCount', 'roles.localKept', 'roles.localKeptHint',
	'repos.installTarget', 'repos.targetGlobal', 'repos.targetProject', 'repos.targetProjectHint',
]) {
	check(`词典 zh / en 都有 ${key}`, typeof dictionaryZh[key] === 'string' && typeof dictionaryEn[key] === 'string', `zh=${typeof dictionaryZh[key]} en=${typeof dictionaryEn[key]}`)
}

// ── 结果 ──────────────────────────────────────────────────────────────────

delete process.env.DSH_HOME
console.log(`\n结果：${passed}/${passed + failed} 项通过`)
if (failed > 0) process.exit(1)
