/**
 * 布局回归探针：把「.sc-body 的子项会被压扁」这件事真的渲染出来量一遍。
 *
 * 为什么需要它：`contract.mjs` 是「源码断言」——它只能证明 CSS 文本里确实有
 * `.sc-body > * { flex: 0 0 auto }` 这行字，**不能证明布局真的修好了**。
 * 本脚本从 `lib/client.js` 里抽出真实 CSS 常量，复刻成两份 HTML：
 *   - old：把修复规则在该根下还原成浏览器的默认 `flex: 0 1 auto`（= 改动前）
 *   - fixed：原样用当前 CSS
 * 然后用 headless Chrome 打开，量 `.sc-group`（订阅卡片）的实际高度。
 *
 * 断言：改动前 `.sc-group` 被压到只剩两条边框（< 6px，而里面的 `.sc-row` 仍近 80px），
 *       改动后恢复到内容高度（> 40px）。
 *
 * 没有 Chrome 时会**跳过并以 0 退出**（不进 `npm test`，也不该在 CI 里假装通过）。
 * 用法：`npm run layout`，或 `CHROME=/path/to/chrome node test/layout-probe.mjs`。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLIENT = join(HERE, '..', 'lib', 'client.js')
const OUT_DIR = join(tmpdir(), 'dsh-skill-console-layout')

const CHROME_CANDIDATES = [
	process.env.CHROME,
	'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
	'/Applications/Chromium.app/Contents/MacOS/Chromium',
	'/usr/bin/google-chrome',
	'/usr/bin/chromium',
	'/usr/bin/chromium-browser',
].filter(Boolean)

const chromePath = CHROME_CANDIDATES.find((candidate) => existsSync(candidate))
if (!chromePath) {
	console.log('[layout] 跳过：没找到 Chrome（设 CHROME=/path/to/chrome 可指定）。')
	process.exit(0)
}

/** 从 client.js 抽出 `const CSS = \`…\`` 模板字符串。 */
function extractCss(source) {
	const marker = 'const CSS = `'
	const start = source.indexOf(marker)
	if (start < 0) throw new Error('lib/client.js 里找不到 `const CSS = ` 模板字符串')
	const from = start + marker.length
	const end = source.indexOf('`', from)
	if (end < 0) throw new Error('CSS 模板字符串没有闭合反引号')
	return source.slice(from, end)
}

const css = extractCss(readFileSync(CLIENT, 'utf8'))
if (!/\.sc-body\s*>\s*\*\s*\{[^}]*flex:\s*0 0 auto/.test(css)) {
	console.error('[layout] 失败：当前 CSS 里没有 `.sc-body > * { flex: 0 0 auto }`，先看 lib/client.js 的样式常量。')
	process.exit(1)
}

const LONG_DESCRIPTION = new Array(60)
	.fill(
		'Browser automation CLI for AI agents. Use when the user needs to interact with websites, including navigating pages, filling forms, clicking buttons, taking screenshots, extracting data.',
	)
	.join(' ')

const page = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>skill-console-layout-probe</title>
<style>
html, body { margin: 0; padding: 0; }
body { font: 13px/1.5 system-ui, sans-serif; }
/* 只在这个根下把修复规则还原成浏览器默认的 flex 行为，用来复刻「改动前」。 */
#BEFORE .sc-body > * { flex: 0 1 auto; }
${css}
/* 0.6.0 探针：三个页签是「同一个槽位里换内容」，所以叠在同一个位置上量——
   依次排开的话绝对 top 必然不同，比的就不是「切页签会不会跳」了。 */
.tab-stage { position: relative; }
.tab-stage > .sc-section { position: absolute; top: 0; left: 0; right: 0; height: auto; min-height: 0; }
/* T7 探针：把角色页签正文本体压窄，逼构成条进入「空间不够」的情形。 */
#TAB-roles .sc-body { max-width: 300px; }
</style></head>
<body>
<!-- 结果元素放在 DOM 最前面：Chrome 常常在 --dump-dom 写完后不肯退出，探针 90s 超时杀它时
     stdout 可能只写到一半——放最后会被截断，量测整份丢失（实测 3 次里挂 1 次，只剩 63KB 前缀）。
     位置不影响任何断言：比的全是相对值（top 相等、高度、左边界差）。 -->
<pre id="results">pending</pre>
<div id="BEFORE">${section('BEFORE')}</div>
${section('AFTER')}
${tabStage()}
<script>
function measure(id) {
	const body = document.getElementById('BODY-' + id)
	const group = body.querySelector('.sc-group')
	const row = body.querySelector('.sc-row')
	const card = body.querySelector('.sc-card')
	const height = (element) => (element ? Math.round(element.getBoundingClientRect().height * 100) / 100 : null)
	return {
		body: height(body),
		repoGroup: height(group),
		repoRow: height(row),
		detailCard: height(card),
		bodyScrolls: body.scrollHeight > body.clientHeight + 1,
	}
}
// 需求 ③「动作按钮移到名称行右侧」：这条只能在真浏览器里量——选择器对得再准，
// 也不能证明按钮真的和输入框同一行、且在勾选列表之前。
// 名称行有没有折成两行：数 head 的直接子元素落在几个不同的横向上。
// 比的是**中线**（top + height/2）而不是 top——空 span（spacer，client.js 里 flex:1）高度为 0，
// 它的 top 落在行的垂直中线上，而 label 的 top 在行的上沿，同一行里两者能差 13px；
// 拿 top 比会把单行误判成两行（实测 top 基准报 2 行、中线基准报 1 行）。
// 也不量高度：flex-wrap 真折行时整行高度只比单行多一点点（实测折行 59px vs 单行 26px），
// 用高度阈值判断会判「只有一行」而放过折行。
// 想亲眼确认这条量测能变红（探针只在受控窗口里跑，缩窗口到不了折行宽度——Chrome 把窗口宽度
// 钳在 500 左右）：临时给页面注入
//   #ROLE-AFTER .sc-role-editor-head { flex-direction: column !important; }
// 或 #ROLE-AFTER .sc-role-editor-head > input { min-width: 1200px !important; }
// 前者 headRows 变 6，后者变 2，两种改法都会让这条断言与「同一行」断言同时失败、退出码 1。
function headRowsOf(head, round) {
	if (!head) return null
	const centers = Array.from(head.children)
		.map((child) => {
			const box = child.getBoundingClientRect()
			return round(box.top + box.height / 2)
		})
		.sort((a, b) => a - b)
	if (centers.length === 0) return 0
	let rows = 1
	for (let i = 1; i < centers.length; i += 1) {
		if (centers[i] - centers[i - 1] > 8) rows += 1
	}
	return rows
}
function measureRole(id) {
	const root = document.getElementById('ROLE-' + id)
	if (!root) return null
	const head = root.querySelector('.sc-role-editor-head')
	const input = head ? head.querySelector('input') : null
	const buttons = head ? Array.from(head.querySelectorAll('button')) : []
	const firstSkill = root.querySelector('.sc-role-skill')
	const round = (value) => Math.round(value * 100) / 100
	const topOf = (element) => (element ? round(element.getBoundingClientRect().top) : null)
	return {
		headHeight: head ? round(head.getBoundingClientRect().height) : null,
		headRows: headRowsOf(head, round),
		inputTop: topOf(input),
		firstButtonTop: topOf(buttons[0]),
		firstSkillTop: topOf(firstSkill),
		buttonsInHead: buttons.length,
	}
}
// 0.6.0 需求②：节头那个唯一的工作区条，切页签时不能跳。
// 页面把三个页签叠在同一个槽位（.tab-stage 里绝对定位），所以「三个 top 全等」曾经被当成
// 这条需求的断言——**那个断言已删**：三份节头共用同一个 head 常量、又落在同一槽位，top 相等
// 是 fixture 自己造出来的（fixture 自证），换个 fixture 才会红，测不到「切页签不跳」这件事。
// 这里保留测量**只作诊断**（打印出来供人眼比对），不再据此判红；判红交给下面那条结构断言。
// 节头里有两条 .sc-bar：标题一条、工作区条一条（与 SkillConsoleSection 同构），取后一条。
function measureBar(id) {
	const tab = document.getElementById('TAB-' + id)
	if (!tab) return null
	const bars = tab.querySelectorAll('.sc-head > .sc-bar')
	if (bars.length < 2) return null
	return Math.round(bars[1].getBoundingClientRect().top * 100) / 100
}
// 0.6.0 需求②的结构断言：工作区**下拉**只长在节头里，页签体内一个都不该有。
// 用「select.sc-select」而不是「.sc-bar」做标识是有原因的：真实 DOM 里 ReposPanel 的
// .sc-body 第一个子节点本来就是一条 .sc-bar（「已订阅的仓库」头），所以「体内没有 .sc-bar」
// 对真实界面为假；而「select.sc-select」全仓只出现在工作区下拉上（.sc-select 这个类还被
// UiInput 用在 input 上，所以必须带 select 限定）。把下拉塞进任一页签体，这条就红。
function measureWorkspaceSelects() {
	const ids = ['skills', 'repos', 'roles']
	return {
		body: ids.reduce((total, id) => total + document.querySelectorAll('#TAB-' + id + ' .sc-body select.sc-select').length, 0),
		head: ids.map((id) => document.querySelectorAll('#TAB-' + id + ' > .sc-head select.sc-select').length),
	}
}
// 0.6.0 需求②：技能页签里两个源块（全局一块、项目一块）。
// 量每块组头的 top（要递增，说明是两块而不是叠在一起）与 caret 相对块标题左边界的位置。
function measureSkillRoots(id) {
	const tab = document.getElementById(id)
	if (!tab) return null
	return Array.from(tab.querySelectorAll('.sc-skillroot')).map((block) => {
		const head = block.querySelector('.sc-group-head')
		const caret = block.querySelector('.sc-caret')
		const title = block.querySelector('.sc-group-title')
		const round = (value) => Math.round(value * 100) / 100
		return {
			headTop: head ? round(head.getBoundingClientRect().top) : null,
			caretLeft: caret ? round(caret.getBoundingClientRect().left) : null,
			titleLeft: title ? round(title.getBoundingClientRect().left) : null,
		}
	})
}
// T3：作用域说明跟页签同排，所以它**不许改变页签条的行高**——否则切到「技能仓库」
// 页签时正文起点会往下跳一下。这条与上面被删掉的「节头 top 全等」不同：节头是三份共用的
// 同一个常量，top 相等是 fixture 自证；而页签条**三个页签确实不一样**（只有 repos 带说明），
// 行高仍相等才是 CSS 的功劳（.sc-scope 自己不换行）。
function measureTabStrips() {
	const round = (value) => Math.round(value * 100) / 100
	return ['skills', 'repos', 'roles'].map((id) => {
		const tab = document.getElementById('TAB-' + id)
		if (!tab) return null
		const strip = tab.querySelector('.sc-tabs')
		const body = tab.querySelector('.sc-body')
		return {
			id,
			stripHeight: strip ? round(strip.getBoundingClientRect().height) : null,
			bodyTop: body ? round(body.getBoundingClientRect().top) : null,
			hasScope: tab.querySelector('.sc-scope') !== null,
		}
	})
}
function measureRibbon() {
	const ribbon = document.querySelector('#TAB-roles .sc-ribbon')
	const body = document.querySelector('#TAB-roles .sc-body')
	const cells = ribbon ? Array.from(ribbon.querySelectorAll('.sc-ribbon-cell')) : []
	const more = document.querySelector('#TAB-roles .sc-ribbon-more')
	if (!ribbon || !body || cells.length === 0) return null
	const round = (value) => Math.round(value * 100) / 100
	const tops = new Set(cells.map((cell) => round(cell.getBoundingClientRect().top)))
	// 「+N 看得见」= 它落在正文的右边界内、且没被祖先裁掉。
	const moreBox = more ? more.getBoundingClientRect() : null
	const bodyBox = body.getBoundingClientRect()
	return {
		rows: tops.size,
		height: round(ribbon.getBoundingClientRect().height),
		clipped: ribbon.scrollWidth > ribbon.clientWidth + 1,
		bodyOverflowsX: body.scrollWidth > body.clientWidth + 1,
		moreVisible: moreBox !== null && moreBox.width > 0 && moreBox.right <= bodyBox.right + 1,
	}
}
function measureSeg() {
	const seg = document.querySelector('#TAB-repos .sc-seg')
	if (!seg) return null
	const items = Array.from(seg.querySelectorAll('.sc-seg-item'))
	const round = (value) => Math.round(value * 100) / 100
	return {
		height: round(seg.getBoundingClientRect().height),
		rows: items.length > 0 ? new Set(items.map((item) => round(item.getBoundingClientRect().top))).size : 0,
	}
}
const result = { viewport: [innerWidth, innerHeight], before: measure('BEFORE'), after: measure('AFTER'), roleAfter: measureRole('AFTER'), barTops: ['skills', 'repos', 'roles'].map(measureBar), workspaceSelects: measureWorkspaceSelects(), skillBlocks: measureSkillRoots('TAB-skills'), tabStrips: measureTabStrips(), ribbon: measureRibbon(), seg: measureSeg() }
document.getElementById('results').textContent = JSON.stringify(result)
</script>
</body></html>`

// `section()` 在生成 HTML 时就要用，且要能被页面里的脚本引用，所以写成具名函数声明。
function section(id) {
	return `
<div class="sc-section">
	<div class="sc-bar"><span class="sc-group-title">已订阅的仓库</span><span class="sc-desc">未配置 GitHub token</span><span class="sc-spacer"></span><button type="button">刷新</button></div>
	<div class="sc-body" id="BODY-${id}">
		<div class="sc-group">
			<div class="sc-row">
				<div class="sc-row-main">
					<div class="sc-row-head"><span class="sc-name">vercel-labs/agent-browser</span></div>
					<div class="sc-desc">commit 0207911 · 子目录 skills</div>
					<div class="sc-desc">1 个技能 · 已安装 1 · 本地有修改 1</div>
				</div>
				<div class="sc-row-actions"><button type="button">编辑</button><button type="button">拉取最新</button><button type="button">移除订阅</button></div>
			</div>
		</div>
		<div class="sc-card">
			<div class="sc-bar"><span class="sc-group-title">仓库里的技能</span><span class="sc-desc">1 个技能</span><span class="sc-spacer"></span><span class="sc-desc">已选 0 个</span><button type="button">全选可更新</button></div>
			<div class="sc-desc">${LONG_DESCRIPTION}</div>
		</div>
	</div>
	<div class="sc-card"><div class="sc-desc">添加仓库</div></div>
	<div class="sc-role-editor" id="ROLE-${id}">
		<div class="sc-role-editor-head"><label>名称</label><input class="sc-select" value="前端"><span class="sc-spacer"></span><button type="button">保存</button><button type="button">取消</button><button type="button">切换到此角色</button></div>
		<div class="sc-role-skills">
			<label class="sc-role-skill" data-skill="rp-alpha"><input type="checkbox"><span class="sc-role-skill-name">rp-alpha</span><span>●</span></label>
			<label class="sc-role-skill" data-skill="rp-beta"><input type="checkbox"><span class="sc-role-skill-name">rp-beta</span><span>○</span></label>
			<label class="sc-role-skill" data-skill="rp-gamma"><input type="checkbox"><span class="sc-role-skill-name">rp-gamma</span><span>○</span></label>
		</div>
	</div>
</div>`
}

/* 0.6.0 需求②的探针场景：三个页签（技能 / 技能仓库 / 角色）各一份节头，
   技能页签里放两块源块（全局 + 项目）。三份节头同构，只有正文不同——
   判红用的是「工作区下拉只在节头里」（measureWorkspaceSelects），
   measureBar 的 top 只打印出来作诊断，不再参与断言。 */
function tabStage() {
	const head = `
		<div class="sc-head">
			<div class="sc-bar"><span class="sc-group-title">技能控制台</span><span class="sc-desc">v0.6.0</span><span class="sc-spacer"></span><button type="button">关闭</button></div>
			<div class="sc-bar"><span class="sc-hint">工作区</span><select class="sc-select"><option>skill-console</option></select><span class="sc-spacer"></span><button type="button">刷新</button></div>
			<span class="sc-sub">启用 / 停用技能，订阅 GitHub 技能仓库。</span>
		</div>`
	// 「技能仓库」页签的页签条里多一条作用域说明（与 SkillConsoleSection 同构）：
	// 它就是这条断言要量住的东西——多了它，页签条不许变高。
	const scopeNote = '<span class="sc-spacer"></span><span class="sc-scope">以下内容全局一份，与工作区无关。</span>'
	const tabs = (extra) => `
		<div class="sc-tabs"><span class="sc-disclosure">技能</span><span class="sc-disclosure">技能仓库</span><span class="sc-disclosure">角色</span>${extra}</div>`
	const root = (title, count, name) => `
			<div class="sc-group sc-skillroot is-open">
				<div class="sc-group-head">
					<button type="button" class="sc-disclosure"><span class="sc-caret" data-open="true"></span></button>
					<span class="sc-group-title">${title}</span>
					<span class="sc-spacer"></span>
					<span class="sc-desc">${count} 个技能</span>
					<button type="button">全部启用</button>
					<button type="button">全部停用</button>
				</div>
				<div class="sc-row">
					<div class="sc-row-main">
						<div class="sc-row-head"><span class="sc-name">${name}</span></div>
						<div class="sc-desc">${title}</div>
					</div>
					<div class="sc-row-actions"><button type="button">详情</button></div>
				</div>
			</div>`
	// T7 探针：构成条一格一个技能（8px + 2px 间距），40 格必须压在一行里、超出部分被裁掉。
	// 这是「小地图」这个说法的物理前提——它一旦能撑破卡片，角色行就会被它挤变形。
	const ribbonCells = new Array(40).fill('<span class="sc-ribbon-cell" data-state="ready"></span>').join('')
	const roleCard = `
			<div class="sc-group">
				<div class="sc-row sc-role-row">
					<div class="sc-role-body">
						<div class="sc-role-main">
							<span class="sc-role-name">开发</span>
							<span class="sc-tag" data-tone="success">已对齐角色</span>
							<span class="sc-spacer"></span>
							<span class="sc-ribbon-wrap"><span class="sc-ribbon">${ribbonCells}</span><span class="sc-ribbon-more">+3</span></span>
							<span class="sc-role-counts">19 / 30</span>
						</div>
					</div>
				</div>
			</div>`
	// T7 探针：技能仓库页签的「订阅 / 可用仓库」分段控件必须并排一行。
	const segBar = '<div class="sc-seg" role="tablist"><button type="button" class="sc-seg-item" data-active="true" role="tab" aria-selected="true">订阅 3</button><button type="button" class="sc-seg-item" role="tab" aria-selected="false">可用仓库 24</button></div>'
	const card = (title, desc) => `
			<div class="sc-card">
				<div class="sc-bar"><span class="sc-group-title">${title}</span><span class="sc-desc">${desc}</span><span class="sc-spacer"></span><button type="button">刷新</button></div>
				<div class="sc-desc">${LONG_DESCRIPTION}</div>
			</div>`
	const tab = (id, body, extra) => `
	<div class="sc-section" id="TAB-${id}">
		${head}
		${tabs(extra)}
		<div class="sc-body">${body}</div>
	</div>`
	return `
<div class="tab-stage">
	${tab('skills', root('全局技能', 12, 'alpha') + root('项目技能', 3, 'beta'), '')}
	${tab('repos', segBar + card('已订阅的仓库', '1 个仓库') + card('仓库里的技能', '1 个技能'), scopeNote)}
	${tab('roles', roleCard + card('可用仓库', '12 个技能'), '')}
</div>`
}

mkdirSync(OUT_DIR, { recursive: true })
const htmlPath = join(OUT_DIR, 'probe.html')
writeFileSync(htmlPath, page)

// Chrome 在 --dump-dom 之后常因为自己的更新器进程不肯退出，所以给个超时；
// 超时被杀也照样能拿到已经写出的 stdout。
const run = spawnSync(
	chromePath,
	[
		'--headless=new',
		'--disable-gpu',
		'--no-sandbox',
		'--no-first-run',
		'--disable-crash-reporter',
		'--disable-breakpad',
		'--disable-component-update',
		`--user-data-dir=${join(OUT_DIR, 'profile')}`,
		'--window-size=1400,600',
		'--virtual-time-budget=2000',
		'--dump-dom',
		`file://${htmlPath}`,
	],
	{ timeout: 90_000, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' },
)

const dom = String(run.stdout || '')
const matched = /<pre id="results">([\s\S]*?)<\/pre>/.exec(dom)
if (!matched) {
	console.error(`[layout] 失败：拿不到测量结果（Chrome 退出码 ${run.status}，DOM ${dom.length} 字节）。`)
	process.exit(1)
}

let measured
try {
	measured = JSON.parse(matched[1])
} catch (error) {
	console.error(`[layout] 失败：测量结果不是合法 JSON：${matched[1].slice(0, 200)}`)
	process.exit(1)
}

const { before, after, roleAfter } = measured
const role = roleAfter ?? {}
const barTops = Array.isArray(measured.barTops) ? measured.barTops : []
const workspaceSelects = measured.workspaceSelects ?? { body: null, head: [] }
const skillBlocks = Array.isArray(measured.skillBlocks) ? measured.skillBlocks : []
const tabStrips = Array.isArray(measured.tabStrips) ? measured.tabStrips : []
const ribbon = measured.ribbon ?? null
const seg = measured.seg ?? null
const checks = [
	['改动前：订阅卡片被压到只剩边框（< 6px）', before.repoGroup !== null && before.repoGroup < 6],
	['改动前：卡片里的仓库行本身仍有高度（说明内容在、只是盒子被压扁）', before.repoRow !== null && before.repoRow > 40],
	['改动前：明细卡片把负自由空间全吸走了', before.detailCard !== null && before.detailCard > before.body],
	['改动后：订阅卡片恢复正常高度（> 40px）', after.repoGroup !== null && after.repoGroup > 40],
	['改动后：仓库行仍然完整', after.repoRow !== null && after.repoRow > 40],
	['改动后：溢出交给 .sc-body 自己滚动', after.bodyScrolls === true],
	['需求③ 角色编辑器：动作按钮与名称输入框在同一行', role.inputTop !== null && role.firstButtonTop !== null && Math.abs(role.inputTop - role.firstButtonTop) < 8],
	['需求③ 角色编辑器：动作按钮在勾选列表之前', role.firstButtonTop !== null && role.firstSkillTop !== null && role.firstButtonTop < role.firstSkillTop],
	['需求③ 角色编辑器：名称行没被 flex-wrap 撑成两行（默认宽度下 headRows===1）', role.headRows === 1],
	['需求③ 角色编辑器：名称行里就是那三个动作按钮', role.buttonsInHead === 3],
	['需求② 工作区下拉只长在节头里，页签体内不再自带一个', workspaceSelects.body === 0 && workspaceSelects.head.length === 3 && workspaceSelects.head.every((count) => count === 1)],
	// 源块这条量的是 **fixture 的结构**（两块 .sc-skillroot 依次排开、caret 贴在块标题左侧），
	// 它不宣称验证 CSS：真实样式在 client.js 里，fixture 只复刻类名与嵌套关系。
	// caret 阈值 24 → 28：留出字体/缩放的漂移余量，不然换台机器就会假红。
	['需求② 技能页签是两块源块，且每块的折叠 caret 贴在块标题左侧', skillBlocks.length === 2 && skillBlocks[1].headTop !== null && skillBlocks[0].headTop !== null && skillBlocks[1].headTop > skillBlocks[0].headTop && skillBlocks.every((block) => block.caretLeft !== null && block.titleLeft !== null && Math.abs(block.caretLeft - block.titleLeft) < 28)],
	// T3：作用域说明只出现在「技能仓库」页签的页签条里（另外两页没有它），
	// 而三个页签的**页签条行高与正文起点必须完全一致**——说明是加在同一行里，不是新起一行。
	['T3 作用域说明只在「技能仓库」页签出现', tabStrips.length === 3 && tabStrips.filter((strip) => strip.hasScope).length === 1 && tabStrips.find((strip) => strip.id === 'repos')?.hasScope === true],
	// T7：构成条是「角色与项目的差异」的小地图，它必须**待在自己那一格里**。
	// 只断言「高度 ≤ 12px」是不够的——cells 的 flex-wrap 默认就是 nowrap，写不写都一样；
	// 真正会退化的地方是 overflow: hidden 被删掉，那时 40 格会把角色行撑宽、
	// 让整个 .sc-body 长出横向滚动条。所以两条一起判：裁掉了 + 没有横向溢出。
	['T7 构成条始终是一行（40 格不许折行把角色卡撑高）', ribbon !== null && ribbon.rows === 1, JSON.stringify(ribbon)],
	['T7 空间不够时构成条收缩并裁掉格子，不撑出横向滚动', ribbon !== null && ribbon.clipped === true && ribbon.bodyOverflowsX === false, JSON.stringify(ribbon)],
	['T7 被裁掉时「+N」仍然看得见（它不许跟着一起消失）', ribbon !== null && ribbon.moreVisible === true, JSON.stringify(ribbon)],
	['T7 技能仓库的分段控件两个视图并排一行', seg !== null && seg.rows === 1 && seg.height > 0, JSON.stringify(seg)],
	['T3 加了作用域说明后页签条不变高、正文起点不下移', tabStrips.every((strip) => strip.stripHeight !== null) && new Set(tabStrips.map((strip) => strip.stripHeight)).size === 1 && new Set(tabStrips.map((strip) => strip.bodyTop)).size === 1, tabStrips.map((strip) => `${strip.id}:${strip.stripHeight}/${strip.bodyTop}`).join(' ')],
]

console.log(`[layout] Chrome：${chromePath}`)
console.log(`[layout] 视口 ${measured.viewport.join('×')}；改动前 ${JSON.stringify(before)}；改动后 ${JSON.stringify(after)}；角色编辑器 ${JSON.stringify(role)}`)
console.log(`[layout] ribbon ${JSON.stringify(measured.ribbon)} seg ${JSON.stringify(measured.seg)}`)
console.log(`[layout] 工作区条 top ${JSON.stringify(barTops)}（只作诊断）；工作区下拉 体内 ${workspaceSelects.body} / 节头 ${JSON.stringify(workspaceSelects.head)}；技能页签源块 ${JSON.stringify(skillBlocks)}`)
let failed = 0
for (const [label, ok] of checks) {
	console.log(`  ${ok ? '✓' : '✗'} ${label}`)
	if (!ok) failed += 1
}
const passed = checks.length - failed
if (failed > 0) {
	console.error(`[layout] ${failed} 项失败：flex 收缩、角色编辑器按钮位置或节头/源块版面可能又回来了。`)
	process.exit(1)
}
console.log(`[layout] ${passed}/${passed + failed} 项通过：订阅卡片不再被压扁，角色编辑器的按钮在名称行里，工作区下拉只在节头里、技能页签是两块。`)
