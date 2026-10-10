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
</style></head>
<body>
<div id="BEFORE">${section('BEFORE')}</div>
${section('AFTER')}
<pre id="results">pending</pre>
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
const result = { viewport: [innerWidth, innerHeight], before: measure('BEFORE'), after: measure('AFTER') }
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

const { before, after } = measured
const checks = [
	['改动前：订阅卡片被压到只剩边框（< 6px）', before.repoGroup !== null && before.repoGroup < 6],
	['改动前：卡片里的仓库行本身仍有高度（说明内容在、只是盒子被压扁）', before.repoRow !== null && before.repoRow > 40],
	['改动前：明细卡片把负自由空间全吸走了', before.detailCard !== null && before.detailCard > before.body],
	['改动后：订阅卡片恢复正常高度（> 40px）', after.repoGroup !== null && after.repoGroup > 40],
	['改动后：仓库行仍然完整', after.repoRow !== null && after.repoRow > 40],
	['改动后：溢出交给 .sc-body 自己滚动', after.bodyScrolls === true],
]

console.log(`[layout] Chrome：${chromePath}`)
console.log(`[layout] 视口 ${measured.viewport.join('×')}；改动前 ${JSON.stringify(before)}；改动后 ${JSON.stringify(after)}`)
let failed = 0
for (const [label, ok] of checks) {
	console.log(`  ${ok ? '✓' : '✗'} ${label}`)
	if (!ok) failed += 1
}
if (failed > 0) {
	console.error(`[layout] ${failed} 项失败：flex 收缩问题可能又回来了。`)
	process.exit(1)
}
console.log('[layout] 6/6 项通过：订阅卡片不再被压扁。')
