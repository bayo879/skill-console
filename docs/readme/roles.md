# 角色（技能组合）

状态：**已实现**（`dsh-skill-console@0.10.1`）。本文件描述**当前已实现**的形态；未实现的目标不写在这里。

---

## 1. 目标

在技能控制台里加第三个标签页「角色」，用来**保存自定义的技能组合**，并通过**切换角色**改变**当前工作区**下生效的技能，**全程不修改全局技能根**。面板上**可以切换要操作哪个工作区**（下拉在节顶的工作区条上，三个页签共用）：切换后，读（角色列表、候选）与写（切换 / 取消角色）都作用在选中的那个工作区上。这个「当前工作区」是**整屏共享**的——技能 / 技能仓库 / 角色三个页签看的是同一个；切换只在节顶那一处，角色页签自己不再带下拉。

角色能挑选的技能来自**可用仓库**（`<DSH_HOME>/skill-console/library/`，见 `docs/HTTP-API.md` 的 `POST /repositories/sync`）：技能仓库把技能**手动同步**到那里，角色再从那里挑、切换时复制进项目。候选与当前工作区、与全局技能根都**无关**——这是 0.7.0 的改动（此前候选是「当前项目技能 + 全局技能」，选中哪个工作区就换一套候选）。

一句话说清它的价值：现在要换一套技能得逐个点开关；有了角色，点一次就换一套。

## 2. 三条已拍板的前提

1. **角色全局共享一份**，所有项目共用同一套角色定义；「当前激活的是哪个角色」按项目分别记录。
2. **严格对齐**：切到某角色后，项目技能根严格等于该角色——角色内的启用、项目里其余的全部停用。
3. **写盘只有两种机制**：项目内对齐用**重命名**（`toggleSkill`），「项目里没有、可用仓库有」的条目用**复制**（`copySkillIntoRoot`，只从可用仓库读、只往项目写）。切换前快照/回滚**当前不做**。

## 3. 硬边界：角色只认可用仓库，全局技能既不被读也不被写

这不是实现细节，是 DSH 的加载模型 + 「角色范围」的设计决定，必须写在这里，也必须写在界面上：

DSH 把技能从「全局根 + 项目根」两份叠加加载，**没有任何「按项目遮蔽全局」的机制**。角色的作用范围**只有项目技能根**，所以：

- 角色的真实效果是 `项目技能根 = 角色集`，再 **∪ 全部全局技能**；角色既不把全局技能复制进来（0.7.0 起），也停用不了全局那份。
- 更刁的一条：角色停用了项目里的技能 `C`，若全局根里也有同名 `C`，那份全局 `C` 会**接管生效**。也就是「角色里没有 C」≠「C 不生效」。

因此：

- 角色编辑器的候选**只有一个来源：可用仓库**。全局根与当前项目技能根都**不出现**在候选里——角色范围与「DSH 实际从哪加载技能」彻底解耦。
- 勾选一个库技能 = 切换时把**库里那份**复制进项目（`copy`）；不勾 = 什么都不做。软链接技能（`toggleable !== true`）不可勾。库里的文件本身只被读、不会被改。
- 切换后如果发生同名接管，**逐条报告**，复用现有 `/toggle` 的 `takeover` 口径（`dsh-plugin/lib/routes.js` 的 `takeoverFor`，定义在文件头部的辅助函数区）。
- 候选与项目现状分两个字段回（`candidates` / `projectSkills`）：界面用 `projectSkills` 算行首的 `●`（本项目已启用）/ `○`，勾选与对齐只认 `candidates`。

## 4. 数据模型与存储

文件：`<DSH_HOME>/skill-console/roles.json`（与 `repositories.json` 同目录）。

```json
{
  "version": 1,
  "roles": [
    { "id": "<uuid>", "name": "前端", "skills": ["a", "b"], "createdAt": 0, "updatedAt": 0 }
  ],
  "active": { "<项目根绝对路径>": "<roleId>" }
}
```

- **规则与 `repositories.json` 完全一致**：原子替换（写 `.tmp-<uuid>` 再 rename）；状态文件损坏时**拒绝一切写入**并抛 `error.role.state`，绝不拿一份空状态覆盖用户磁盘上那份（见 `store.js` 的两条硬规则）。
- `skills` 存**技能名**，不存路径 → 角色跨项目可复用；本项目不存在的名字标 `missing`。
- 角色名唯一（同名 upsert 到不同 id 时 409）。
- 上限：`MAX_ROLES = 50`，每角色 `MAX_ROLE_SKILLS = 200`（与 `routes.js` 的 `MAX_BATCH` 对齐）。
- `active` 的 key 是**项目根绝对路径**。这是刻意的：它让「同一个角色在不同项目里有不同的激活状态」成立。代价是项目移动/改名后失配 → 视为未激活（不报错，界面上就是「未激活」）。状态文件里出现绝对路径不违反「界面上不显示地址」那条约定——那是界面约定。

## 5. 宿主新模块 `lib/roles.js`

只做三件事，**职责不与 `roots.js` 重叠**（`roots.js` 继续独占文件系统那一侧）：

| 导出 | 职责 |
| --- | --- |
| `createRoleStore({ stateDir, log })` | 持久化。返回 `{ load, save, list, get, upsert, remove, activeFor, setActive, clearActive, stateFile }`。**完全不碰技能文件。** |
| `planRole({ role, skills, sources })` | **纯函数**，不碰盘。`skills` 是项目根扫描结果、`sources` 是**可用仓库**的扫描结果（只读来源，不落盘；路由层用 `scanRoot` 扫一个合成根，库不在 `ROOT_DEFS` 里）。算出这次切换要做哪些动作。 |
| `applyRole(projectRoot, plan)` | 逐项调 `toggleSkill`（enable/disable）或 `copySkillIntoRoot`（copy），逐项回收结果。 |

### `planRole` 的返回形状

```js
{
  steps:   [{ name, path, action: 'enable'|'disable', current, target }],
           // 项目里没有、角色要、可用仓库有 → { name, path: null, action: 'copy', current: false,
           //   target: true, sourcePath, sourceKind }；目标路径由 applyRole 用 targetPathFor 算
  noop:    [{ name, path, enabled }],               // 已经在目标态
  skipped: [{ name, path, reason: 'symlink' }],     // 不可启停（项目里的，或全局来源是软链接）
  missing: [name],                                  // 角色里有、项目与可用仓库都没有
  stats:   { total, copy, enable, disable, noop, skipped, missing }
}
```

`stats.total = copy + enable + disable + noop + skipped`；项目里已有同名的技能**既不进 `plan` 也不计动作数**——本地那份优先，库里那份绝不被用来覆盖它。这是常态，不是需要报告的差异（详见 §6 的 `GET /roles`）。

`stats.disable` 就是「项目里有、角色里没有」的数量，界面直接用它讲「切换会停用 N 个」。

**同名双副本**（一个根里同时存在 `foo/SKILL.md` 和 `foo.md`，两者 `name` 都是 `foo`）：角色按名字存，所以两条记录**一起处置**。这是刻意的语义，写进 README。

### `applyRole` 的结构性保证

签名是 `applyRole(projectRoot, plan)`，其中 `projectRoot` 是**单个**根描述对象。内部这样调：

```js
toggleSkill([projectRoot], step.path, step.target)                                       // enable / disable
copySkillIntoRoot(projectRoot, { ...readSkill(step.sourcePath), kind: step.sourceKind })  // copy
```

于是「不修改全局」有**两层结构保证**，而不是一句 `if (scope === 'project')`：

1. 全局根根本不进入 `applyRole` 的入参链路；
2. 即使有 bug 把全局路径塞进 `plan`，`classifyDiscoveryPath` 也只会认它落在 `[projectRoot]` 里的路径，否则抛 `error.path.outsideRoots`。

第 2 层是可测的，契约测试专门为它写一条。`copy` 步骤同理：`copySkillIntoRoot` 的第一个参数就是传入的那个 `projectRoot`，源路径只在**读**的一侧出现（`step.sourcePath`）。

## 6. 路由契约（6 个端点，2 读 4 写）

沿用现有铁律：读端点是 `GET`，写端点是 `POST` + `content-type: application/json` + `x-skill-console: 1`，围栏在 `http.js`，错误壳统一 `{ok:false, code, error}`。

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/roles` | 角色列表 + 本项目激活角色 + 对齐状态 |
| GET | `/roles/preview?role=<id>` | 切换会做什么（**只读，不落盘**） |
| POST | `/roles/save` | 新建/更新角色 `{id?, name, skills[]}` |
| POST | `/roles/remove` | 删除角色 `{id}`（**不动磁盘**） |
| POST | `/roles/activate` | 对齐：把项目技能根切到该角色 `{id, project?}` |
| POST | `/roles/deactivate` | 只清本项目的激活记录 `{project?}`（不动磁盘） |

角色自己的四个写端点（`save` / `remove` / `activate` / `deactivate`）都**读请求体**；其中 `project`（**工作区目录路径**，0.6.0 起）只对 `/roles/activate` 与 `/roles/deactivate` 有意义，
用来指定**要操作哪个工作区**：给了就**只认它**——不是存在的目录就 400 `error.workspace.invalid`，
**绝不回落到请求头会话**；`project` 省略时才按 `x-skill-console-session` 头严格解析，
会话 id 不存在 / 拿不到 cwd → 400 `error.role.noProject`，**不会回落到「最近一个会话」**。
`GET /roles` 与 `GET /roles/preview` 是读接口：`?project=<工作区目录路径>` 优先于请求头，
给了但无效同样是 400 `error.workspace.invalid`；**没给**时才按会话宽松解析，
解析不出时回落最近会话并在 `project.fallback` 里置 `true`。

### `GET /roles` 响应

```
{
  roles: [{ id, name, skills, updatedAt, active: bool, plan }],   // 0.10.0 起每个角色都带自己的 plan（见下）
  active: { id, name } | null,
  project: { name, fallback },              // fallback=true 时界面必须显式提示
  status: 'unassigned' | 'matched' | 'drifted',
  stats: { inRole, total, copy, enable, disable, noop, skipped, missing },
  candidates: [{ name, path, enabled, toggleable, readOnlyReason, description, installed }],   // 只来自可用仓库（平面数组）
  projectSkills: [{ name, path, enabled, toggleable, readOnlyReason, description, installed }], // 本项目现状，只用来算 ●/○
  library: { path, count }                                            // 可用仓库在哪、有几个技能
}
```

- **`candidates` 是平面数组，唯一来源是可用仓库**（0.7.0）。项目技能与全局技能都**不在**候选里；候选里的
  `enabled` 是「库里那份文件是否启用」（同步进来的都是启用态，所以基本恒为 `true`），能不能勾一律由
  `toggleable` 表达：软链技能是 `toggleable: false` + `readOnlyReason: 'symlink'`。
- **`description` 与 `installed` 是 0.9.0 补的**（两个数组同一套 `candidateOf`）：`description`
  是 frontmatter 的简介（缺失时空串），`installed` 是订阅安装快照 `{id, owner, name, commit, sourcePath, syncedAt}`
  （查的是 `libraryIndex()`，所以带 `syncedAt`）、非订阅为 `null`——角色编辑页靠这两个字段在候选行上显示**所属仓库**与明细。
- **`projectSkills` 是本项目现状**，同一套 `candidateOf`，只用来算行首 `●`（同名已启用）/ `○`（没有或没启用）与界面上的数量——它**不参与勾选**。它与候选的差别在 `installed`：查的是**合成表 `sourceIndex()`**——先 `installedIndex()`（`record.skills` 台账，那份快照**没有 `syncedAt`**），查不到再退 `libraryIndex()`（`record.library`）。
  - 为什么要退：项目安装**刻意不写** `record.skills`（`dsh-plugin/lib/repos.js` 的 `installSkill`：免得顶掉全局那份的记录），所以从可用仓库「同步到项目」之后，只看台账时那一份查不到来源，界面会把一个明明来自订阅的技能显示成「本地（非订阅）」。退路是安全的：`/library/install` 从不覆盖已存在的同名技能（返回 `localKept`），项目里与库同名的技能只可能是从库里复制过去的。
  - 库为空时 `candidates` 是空数组，界面给「去技能仓库页签同步」的引导。
- `stats.enable` / `stats.disable` / `stats.copy` 就是这次切换的落盘动作数（直接来自 `planRole`）：界面用 `disable` 讲「切换会停用 N 个」、用 `copy` 讲「会从可用仓库复制 N 个进来」。
- **项目里已有同名时本地那份优先，且不报告（0.10.1 起）**：项目里已有同名技能就保留项目那份，库里那份**绝不覆盖**它。响应里**没有** `localKept` 字段——它等于「项目技能 ∩ 可用仓库」，与角色选了什么无关、恒有内容，对决策没有信息量；差异只在切换时讲，且只讲「角色要、本地没有」的那些（界面用 `copy` 讲「会从可用仓库复制 N 个进来」）。
- **`plan` 是 0.10.0 补的**（每个角色一份，不只是激活的那个）：结构与 `/roles/preview` 的产物完全一致
  （`{steps, noop, skipped, missing, stats}`），激活角色直接复用已算过的那份、其余角色各自
  `planRole` 一次。角色页靠它逐技能讲差异——以前只有「N 个技能」这个数，差异必须点进编辑态才看得见。
  客户端不读它也能跑（纯增量字段）。
- `status` 由 `planRole` 推导：无激活角色 → `unassigned`；否则 `steps` **与** `missing` **与** `skipped`
  **三者全空**才 `matched`，只要有一个非空就是 `drifted`（判据收敛在 `verdictOf`，`/roles` 与
  `/roles/preview` 共用）。
  > **0.9.0 的谎（0.10.0 修掉）**：旧判据只看 `steps`。于是「角色要一个库里根本没有的技能」（`missing`）
  > 与「要的技能在库里是软链、根本复制不了」（`skipped`）都会被报成 `matched`——**一件都没做，界面却显示
  > 「已对齐」**。这两类都是永远不会被执行的事，必须算偏离。`stats.missing` / `stats.skipped` 仍单独讲数量。
- **`drifted` 不自动纠正**：手工改过开关就显示「已偏离角色」，等用户主动再切一次。

### `GET /roles/preview?role=<id>` 响应

`{ role: {id,name}, status, steps, noop, skipped, missing, stats }` —— 就是 `planRole` 的产物加角色信息，供确认弹窗显示「将复制 M / 启用 N / 停用 K」，并**点名**「角色要、本地没有」的技能（哪些会从可用仓库复制进来、哪些库里也没有、切换后仍然缺）；`copy` 的来源是可用仓库。

这里的 `status` 与 `GET /roles` 是同一条判据（`verdictOf`）。**别与 `POST /roles/activate` 的 `status` 混用**：那是「这次执行成不成功」（`failed === 0 ? 'matched' : 'drifted'`），同一个字段名在两个端点里回答两个问题。

### `POST /roles/activate` 响应

```
{
  role: { id, name },
  status: 'matched' | 'drifted',
  results: [{ name, path, action, ok, enabled, changed, code?, error? }],  // 逐项，坏了一个不影响其他项
  changed: <number>,
  takeover: [{ name, by: [{ root, label, scope, path }] }]    // 停用后被全局同名接管的清单
}
```

执行完成后与 `/toggle-batch` 一致：`changed > 0` 时 `refreshSkills()`，每个改动的路径各发一次 `notifyFileChanged`。

### 错误码

| 码 | 状态 | 场景 |
| --- | --- | --- |
| `error.role.state` | 500 | `roles.json` 损坏，拒绝覆盖 |
| `error.role.unknown` | 404 | roleId 不存在 |
| `error.role.name` | 400 | 角色名为空/非法 |
| `error.role.duplicate` | 409 | 角色重名 |
| `error.role.tooMany` | 400 | 角色数或每角色技能数超上限 |
| `error.role.skills` | 400 | `skills` 不是字符串数组 |
| `error.role.noProject` | 400 | 解析不出项目根（`/roles/activate`、`/roles/deactivate`；同一枚码也用于 `/skills/move-to-library`（来源是项目技能时）与 `target:'project'` 的 `/repositories/install`，见 `docs/HTTP-API.md`） |
| `error.proto.missingId` | 400 | 复用现有 |
| `error.path.outsideRoots` | 400 | 复用现有（第二层保证触发时） |

逐项结果里还可能出现复制自身的码（`error.copy.exists` 409、`error.transfer.symlink` 400、`error.skill.notFound` 404）——它们只出现在 `results[]` 的单项里，不影响其余项。

## 7. 客户端（`lib/client.js`）

- `DICT` 补 `tab.roles` 与一组 `roles.*` 文案，**zh/en 两份必须齐全**（缺一份算契约失败，现有测试守着这条规矩）。
- `sc-tabs` 第三个 `UiPill`；三个页签各自裹一层 `PanelBoundary`，一个 tab 炸了不影响另外两个。
- **`RolesPanel` 单列平铺**（0.10.0 把原来的左右两列收成一列：窄窗口下左列会把差异挤没）：
  - **头部**：全局状态徽标（已对齐 / 已偏离 / 未激活）+ 激活角色名 + `fallback` 警告 + 复制数量 + `新建角色` / `取消角色`。当前工作区名在节顶工作区条上，**不在**角色页签头部。
  - **每个角色一行**（`RoleRow`）：`[展开][名字][状态徽标][N 个技能]` + 换行后是**构成条 + 计数文案**，右侧 `切换到此角色` / `编辑` / `删除`。
- **构成条（`RoleRibbon`）与计数文案（`roleDiffText`）在折叠态也显示**——这就是需求 ② 的「一直显示」。以前差异只有点「编辑」进草稿模式才看得见，界面对「这角色现在跟项目差在哪」的答案只有一句「已偏离」。
  - 一格 = 一个技能（8×8、圆角 2、间距 2），**顺序与展开清单逐行对应**，是清单的小地图。
  - 超过 `RIBBON_MAX_CELLS`（40）截断，右挂 `+N`；`+N` **不在裁剪框内**（见下）。
  - 色只表达**对项目的影响方向**，更细的动作差异由文案承担：`ready` 绿（低透明度）/ `gain` 蓝 / `lose` 黄 / `missing` 红 / `skipped` 斜纹。
  - 整块 `aria-hidden`，含义由旁侧的计数文案承载（读屏不该去数 40 个色块）。
  - **非激活角色同样显示**，计数前缀「若切换：」；状态徽标用新的 `roles.statusInactive`「未激活」——以前对非激活角色说的是「未启用角色」，等于拿一个角色的局部状态去描述整个项目（修 F16）。
- **展开 = 差异清单（`RoleDiffList`），不是编辑器**：「编辑」是清单之外的次要动作，点它才展开 `RoleEditor` 草稿。
  - 两段：会执行的一组在前，`不会被执行`（`roles.diffBlocked`）作为后缀组——`missing` 与 `skipped` 单独成组，不混进「会生效 / 会失效」，否则就是 F3 那个谎的界面版。
  - 每行：`[技能名][StateMark 状态标记 + 动作说明 + 原因]`。原因分 `readonly`（项目里只读）/ `symlink`（库内是软链）。
  - **危险动作有可核对的面**：清单本身就是确认面，`按此差异切换`（`roles.applyDiff`）贴在清单下 20px 内，确认框降级成一句 `roles.applyDiffConfirm`（`按上面这份差异切换「{project}」？`）——不再用 `window.confirm` 报一串数字让人无从核对。
  - **库同步情况**（一期诚实版）：行内不显示「你的项目落后了」——项目侧台账 `installedIndex()` 0.8.0 后基本为空，拿不到项目当前装的 commit，**给不出来就不暗示**。来源与同步时间由 `SkillSourceLine` / `installed.syncedAt` 承担（来源经 `sourceIndex()` 合成，见上：退到库台账时带着 `syncedAt`）。
- **单一事实来源**：构成条与清单都由 `roleSkillStates(plan, projectSkills)` 产出的**同一张有序表**驱动（正常走 `/roles` 的 `role.plan`；缺 `plan` 时为兼容退回客户端复算）。顺序是「会执行的一律在前、不会执行的收成后缀（skipped 再 missing）」——这样「顺序与清单逐行对应」才成立。
- **状态词汇表只有一处**：`SKILL_STATE`（`ready` / `gain` / `lose` / `missing` / `skipped`）配 `StateMark` 组件（`UiStateDot` + 文案）。色只表达对项目的影响方向。`UiStateDot` 的 `data-state` 从 3 态（`done` / `error` / 默认灰）扩到 5 态，新增 `info` / `warn` / `muted`（`muted` 用 45° 斜纹 = 「存在但动不了」，与实色的「不需要动」区分）。
- `roleRowStatusKey(status, active)` 与 `roleStatusKey(status)` 分开：前者答「这一行角色自己的状态」（非激活一律「未激活」），后者答「当前激活角色与项目的关系」。
- 新增测试导出：`RoleRow`、`RoleEditor`、`roleStatusOf`、`roleStatusKey`、`roleRowStatusKey`、`roleToneOf`、`roleSkillStates`、`roleDiffText`、`RoleRibbon`、`RoleDiffList`、`RIBBON_MAX_CELLS`、`SKILL_STATE`、`skillStateOf`（沿用现有 `exports.*` 测试面）。

### 单文件增长的取舍（已知代价）

角色面板约 +500~550 行，后续又加了「共享项目上下文」（`useProjectContext` / `ProjectSelect`）与技能页签的仓库分组、两级折叠，0.9.0 再加可用仓库块与候选行的来源 / 详情，0.10.0 又把库块从技能页签搬到技能仓库页签（一页两视图）+ 角色页的构成条与差异清单，`client.js` 现在 **4176 行**（`wc -l dsh-plugin/lib/client.js`，0.10.1 收尾时；0.7.0 收尾时是 3493 行——0.8.0 撤掉批量层与安装块后**变短了**，0.9.0 又**变长了**），远超「单文件 2000 行」的线。**这个文件拆不了**：`dsh.client` 只服务 `./client.js` 一个文件，且整个客户端 bundle 是手写的 lazy-CJS（`window.__ModuleLoader__.load`），**没有构建步骤**。

已选择：**接受增长，不引入构建机制**（保住「改代码就生效」，且没有「改了源码忘了跑构建、界面静默跑旧代码」这种故障态）。缓解办法是把角色面板的**逻辑尽量压到宿主 `roles.js`**，客户端只留渲染。

## 8. 边角处置

| 边角 | 处置 |
| --- | --- |
| 一个项目根里同名双副本 | 角色按名字存，切换时同名记录一起处置 |
| 角色里的技能在本项目不存在 | 标 `missing`，不报错，切换前提示 |
| 用户手工改了开关，与角色不符 | 显示「已偏离角色」，**不自动纠正** |
| 激活中的角色被改名/删除 | 该项目的激活记录失效，视为未激活，**不还原磁盘** |
| 项目根移动/改名 | 激活记录失配，同上 |
| 软链接技能 | 跳过并报告（不可启停） |
| 停用项目副本后全局同名接管 | 复用 `takeoverFor` 口径逐条报告 |
| 项目里已有同名 | 保留项目那份，该条目自身该开/关的照旧，**绝不用库里那份覆盖项目**；既不进 `plan` 也不报告（恒有内容，不是差异） |
| 角色要、项目没有、可用仓库有 | `action:'copy'` 从可用仓库复制进项目根，复制出来是启用态（源的 `.disabled` 状态不带过去） |
| 角色要、项目与可用仓库都没有 | 记 `missing`，只提示、不算失败（多半是还没同步，或库里那份被删了） |
| 可用仓库里的来源是软链接 | 进 `skipped`（`reason: 'symlink'`），不复制 |
| 项目技能根不存在 | 候选**不受影响**（候选只来自可用仓库）；项目与可用仓库都没有的报 `missing`；库里有的会被复制进项目，并随复制创建项目技能根目录 |
| 可用仓库目录不存在 | 等同于空库：`candidates` 为空、`library.count` 为 0，界面引导去同步 |

## 9. 测试覆盖（沿用现有三层）

**`test/contract.mjs`（离线；0.10.1 收尾时全量 970 项）**

- 角色 CRUD；`roles.json` 损坏时拒绝写入且原文件不动；角色数/技能数上限；重名 409；名字非法 400。
- `planRole` 纯函数：`copy` / `missing` / `disable` / 软链进 `skipped` / 同名双副本一起处置 / 连切两次第二次全 `noop` / `stats.total = copy+enable+disable+noop+skipped`；项目里已有同名的技能**既不 copy 也不进 `plan`**（断言 `plan.localKept === undefined`）。
- **`applyRole` 只动项目根**：造一个全局技能，切换后断言它的文件名与 `mtime` 一个字节没变（含 `copy` 那一轮）；再造一个「plan 里塞了全局路径」的用例，断言抛 `error.path.outsideRoots`。
- **候选与技能根解耦（0.7.0）**：角色路由那一节同时放三份夹具——库里的 `rp-global`、全局技能根里的 `rp-only-global`（反例）、项目技能根里的 `rp-alpha`；断言候选里有 `rp-global`、没有另外两个，`copy` 步骤的 `sourcePath` 指向**库**而不是全局根；整节跑完库文件内容一个字节没变。
- **可用仓库同步（0.7.0）**：`repos.js` 一节直测 `sync()`——落库、不碰技能根、幂等（`synced` 空 / `unchanged` 全覆盖 / 连 mtime 都不动）、本地改过默认跳过且 `confirm` 才覆盖并留备份、上游前进跟着走、清单缓存丢了自动重拉；路由一节再端到端打一次 `POST /repositories/sync`（含缺 `id` 400 与**不带会话头也能成功**）。
- 漂移：手工改一个开关 → `status === 'drifted'`。
- 激活角色被删 → `active` 失效、`status === 'unassigned'`。
- **0.10.0 新增**：每个角色都带 `plan`（且与 `/roles/preview` 逐字段一致）；`missing` / 库内软链 `skipped` 两种情形下 `status` 都是 `drifted`（**反向验证过**：把 `verdictOf` 改回「只看 `steps`」这两条立刻变红）；`roleToneOf` / `roleRowStatusKey` / `roleSkillStates`（七种行的顺序与状态）/ `SKILL_STATE` 五态 / `roleDiffText`；构成条能收缩（`min-width: 0`）且 `+N` 在裁剪框外。
- 客户端：模块表注册 id、第三个 tab 的两份 locale 齐全、缺 primitives / 缺 slots / 缺 locale 都不崩；角色名输入框的 `onChange` 交出字符串（有 / 无 primitives 两条路径都测，宿主 `Input` 与退化实现都是原生 `<input>` 事件透传）。

**`test/integration-cordis.mjs`**：在真 cordis 上按既有形状加一条 `GET /roles` 探针（`provideServices: {}`，不注入 services），断言 200 + JSON 壳，且 `data.status` 是字符串、`data.roles` / `data.candidates` / `data.projectSkills` 都是数组。注意它读的是真实 `~/.dsh` 下的 `roles.json`：`GET` 不写盘，跑完 `~/.dsh/skill-console/` 不该多出文件。

**`test/smoke.mjs`**：只加一次**零动作角色往返**——用 `projectSkills` 里当前已启用的项目技能拼一个夹具角色（不能拿候选拼：候选现在是可用仓库，与项目现状无关）（`zz-skill-console-smoke-role`，同名已存在即退出），`save` → `preview`（断言 `steps.length === 0`）→ `activate`（断言 `changed === 0`、`status === 'matched'`）→ `deactivate` → `remove`，最后再读一次 `/roles` 断言夹具已清掉。

为什么**不**在冒烟里测「真实的角色切换」：`smoke.mjs` 打的是用户**真实运行中的 DSH 与真实工作区**，并不存在「临时项目技能根」可建；而 `activate` 的语义就是把项目技能根里**角色外**的技能全部停用——为了验证一个接口，把用户项目里的一批技能关掉，代价与收益完全不成比例。上面这版方案仍然真走了写路径（`save`/`activate`/`remove` 都落盘），只是角色恰好等于现状，所以 `changed === 0`、盘上一个技能文件都不动。真正的对齐语义（复制 / 启用 / 停用 / 同名不进计划 / 软链跳过 / 逐项隔离 / 全局不可达）由 `test/contract.mjs` 在**临时目录**里覆盖——那里可以随便造技能根。

## 10. 相关文档与版本

- `README.md`：功能节的「角色 tab」、设计边界的第 4 / 5 条、已知边界里「角色排除不掉全局技能」「可用仓库没有管理界面」与「客户端单文件超 2000 行」几条、模块表的 `roles.js` 行，都是本文件的入口摘要。
- `docs/HTTP-API.md` 第 16–21 节是这 6 个角色端点的冻结契约（含 `copy` / `missing` 字段）；第 13 节是 `POST /repositories/sync`（写入可用仓库）。
- 插件版本 `0.10.1`（`dsh-plugin/package.json` 的 `version`，面板头部显示的就是它）。
- `planRole` 的 `sources` 现在是**可用仓库**的扫描结果；不传时按「没有可用来源」处理，只是不会有 `copy`。

## 11. 明确不做的事

- **不做切换前快照 / 一键回滚**（当前）。严格对齐一次可能停用几十个技能，但现有 `backups.js` 是「文件内容快照」，给状态对齐用会引入第二套一致性问题，收益不足以抵掉它。
- **不做「角色决定全局技能」**。技术上必须写全局根，与前提冲突。
- **不做角色继承 / 分组 / 标签**。平铺一层够用。
- **角色不搬运技能**：角色只会启用 / 停用项目里的技能，以及把全局有的**复制**进项目；不会把项目里的技能移走或删除。「删除技能 / 移到可用仓库」是技能 tab 里独立的显式动作（都先备份）；其中「移到可用仓库」只在技能还没被当前角色管着、且库里没有同名时才出现。
- **不做可用仓库的管理界面**（0.10.0 起在**技能仓库页签**里浏览：页内分段控件切到「可用仓库」，支持按名字/简介筛选 + 按来源分组 + 行内「详情」/「同步到项目」，仍然没有删除 / 停用 / 自动清理）。0.9.0 曾把库只读展示在技能页签第三个块里，0.10.0 撤掉——「可用范围」与「订阅来源」是同一件事的两面，分在两个页签会让「这个技能哪来的 / 怎么分发」割裂。库只是角色候选与复制来源的存放处：清理由用户自己删目录，上游删掉的技能不会自动从库里消失（卡片上的「与最新清单一致 / 不一致」两个数才是准的）。
- **不做自动同步 / 定时同步**。链路必须由人手点「同步到可用仓库」触发。
- **不做自动对齐**。打开面板不会静默改盘——写操作必须由用户显式点击。
