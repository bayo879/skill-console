# 角色（技能组合）— 设计与规格

状态：**已实现**（`dsh-skill-console@0.3.0`）。逐条实施计划与约束见 `docs/readme/roles-plan.md`；本文件描述最终形态。

---

## 1. 目标

在技能控制台里加第三个标签页「角色」，用来**保存自定义的技能组合**，并通过**切换角色**改变**当前项目**下生效的技能，**全程不修改全局技能根**。

一句话说清它的价值：现在要换一套技能得逐个点开关；有了角色，点一次就换一套。

## 2. 三条已拍板的前提

1. **角色全局共享一份**，所有项目共用同一套角色定义；「当前激活的是哪个角色」按项目分别记录。
2. **严格对齐**：切到某角色后，项目技能根严格等于该角色——角色内的启用、项目里其余的全部停用。
3. **写盘机制用重命名对齐**（复用现有唯一的破坏性写操作 `toggleSkill`），不引入第二种写盘方式；切换前快照/回滚**本期不做**。

## 3. 硬边界：全局技能无法被角色排除

这不是实现细节，是 DSH 的加载模型决定的，必须写在这里，也必须写在界面上：

DSH 把技能从「全局根 + 项目根」两份叠加加载，**没有任何「按项目遮蔽全局」的机制**。所以只要不修改全局：

- 角色的真实效果是 `项目技能根 = 角色集`，再 **∪ 全部全局技能**；
- 更刁的一条：角色停用了项目里的技能 `C`，若全局根里也有同名 `C`，那份全局 `C` 会**接管生效**。也就是「角色里没有 C」≠「C 不生效」。

因此：

- 角色编辑器里**列出全局技能，但灰显只读**，逐条注明「不受角色控制，仍然生效」。
- 切换后如果发生同名接管，**逐条报告**，复用现有 `/toggle` 的 `takeover` 口径（`../../dsh-plugin/lib/routes.js` 的 `takeoverFor`，定义在文件头部的辅助函数区）。
- README「已知边界」新增一条，把这件事写明。

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
- `active` 的 key 是**项目根绝对路径**。这是刻意的：它让「同一个角色在不同项目里有不同的激活状态」成立。代价是项目移动/改名后失配 → 视为未激活（不报错，界面上就是「未启用角色」）。状态文件里出现绝对路径不违反「界面上不显示地址」那条约定——那是界面约定。

## 5. 宿主新模块 `lib/roles.js`

只做三件事，**职责不与 `roots.js` 重叠**（`roots.js` 继续独占文件系统那一侧）：

| 导出 | 职责 |
| --- | --- |
| `createRoleStore({ stateDir, log })` | 持久化。返回 `{ load, save, list, get, upsert, remove, activeFor, setActive, clearActive }`。**完全不碰技能文件。** |
| `planRole({ role, skills })` | **纯函数**，不碰盘。算出这次切换要做哪些动作。 |
| `applyRole(projectRoot, plan)` | 逐项调 `toggleSkill`，逐项回收结果。 |

### `planRole` 的返回形状

```js
{
  steps:   [{ name, path, action: 'enable'|'disable', current, target }], // 真正会落盘的动作
  noop:    [{ name, path, enabled }],                                     // 已经在目标态
  skipped: [{ name, path, reason: 'symlink' }],                           // 不可启停
  missing: [name],                                                        // 角色里有、本项目没有
  stats:   { total, enable, disable, noop, skipped, missing }
}
```

`stats.disable` 就是「项目里有、角色里没有」的数量，界面直接用它讲「切换会停用 N 个」。

**同名双副本**（一个根里同时存在 `foo/SKILL.md` 和 `foo.md`，两者 `name` 都是 `foo`）：角色按名字存，所以两条记录**一起处置**。这是刻意的语义，写进 README。

### `applyRole` 的结构性保证

签名是 `applyRole(projectRoot, plan)`，其中 `projectRoot` 是**单个**根描述对象。内部这样调：

```js
toggleSkill([projectRoot], step.path, step.enabled)
```

于是「不修改全局」有**两层结构保证**，而不是一句 `if (scope === 'project')`：

1. 全局根根本不进入 `applyRole` 的入参链路；
2. 即使有 bug 把全局路径塞进 `plan`，`classifyDiscoveryPath` 也只会认它落在 `[projectRoot]` 里的路径，否则抛 `error.path.outsideRoots`。

第 2 层是可测的，契约测试专门为它写一条。

## 6. 路由契约（新增 6 个端点，2 读 4 写）

沿用现有铁律：读端点是 `GET`，写端点是 `POST` + `content-type: application/json` + `x-skill-console: 1`，围栏在 `http.js`，错误壳统一 `{ok:false, code, error}`。

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/roles` | 角色列表 + 本项目激活角色 + 对齐状态 |
| GET | `/roles/preview?role=<id>` | 切换会做什么（**只读，不落盘**） |
| POST | `/roles/save` | 新建/更新角色 `{id?, name, skills[]}` |
| POST | `/roles/remove` | 删除角色 `{id}`（**不动磁盘**） |
| POST | `/roles/activate` | 对齐：把项目技能根切到该角色 `{id}` |
| POST | `/roles/deactivate` | 只清本项目的激活记录 `{}`（不动磁盘） |

### `GET /roles` 响应

```
{
  roles: [{ id, name, skills, updatedAt, active: bool }],
  active: { id, name } | null,
  project: { name, fallback },              // fallback=true 时界面必须显式提示
  status: 'unassigned' | 'matched' | 'drifted',
  stats: { inRole, enable, disable, noop, missing, skipped },
  candidates: {
    project: [{ name, path, enabled, toggleable, readOnlyReason }],
    global:  [{ name, path, enabled, toggleable, readOnlyReason, readOnly: true, reason: 'global-uncontrollable' }]
  }
}
```

- `stats.enable` / `stats.disable` 就是这次切换的落盘动作数（直接来自 `planRole`），界面用 `disable` 讲「切换会停用 N 个」。
- `status` 由 `planRole` 推导：无激活角色 → `unassigned`；`steps` 为空 → `matched`；否则 → `drifted`。注意 `missing` **不影响** `status`——角色里本项目不存在的技能只是没得管，不算「磁盘偏离角色」；它由 `stats.missing` 单独讲。
- **`drifted` 不自动纠正**：手工改过开关就显示「已偏离角色」，等用户主动再切一次。

### `GET /roles/preview?role=<id>` 响应

`{ role: {id,name}, status, steps, noop, skipped, missing, stats }` —— 就是 `planRole` 的产物加角色信息，供确认弹窗显示「将启用 M / 停用 N」。

### `POST /roles/activate` 响应

```
{
  role: { id, name },
  status: 'matched' | 'drifted',
  results: [{ name, path, ok, changed, code? }],   // 逐项，坏了一个不影响其他项
  changed: <number>,
  takeover: [{ name, by: [{ root, label, scope, path }] }]  // 停用后被全局同名接管的清单
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
| `error.proto.missingId` | 400 | 复用现有 |
| `error.path.outsideRoots` | 400 | 复用现有（第二层保证触发时） |

## 7. 客户端（`lib/client.js`）

- `DICT` 补 `tab.roles` 与一组 `roles.*` 文案，**zh/en 两份必须齐全**（缺一份算契约失败，现有测试守着这条规矩）。
- `sc-tabs` 加第三个 `UiPill`；新面板照现有规矩裹一层 `PanelBoundary`，一个 tab 炸了不影响另外两个。
- `RolesPanel` 布局：
  - **头部**：当前项目名 + 激活角色 + 状态徽标（已对齐 / 已偏离 / 未启用角色）+ `fallback` 提示。
  - **左列**：角色列表（名字、技能数、`切换` / `编辑` / `删除`）+ `新建角色`。
  - **右列**：编辑器
    - 「项目技能」可勾选——这是角色真正能控制的部分；
    - 「全局技能」灰显只读，逐条「不受角色控制，仍然生效」；
    - 角色里本项目不存在的技能单列 `missing`，可移除；
    - `保存` = 改草稿（只写 `roles.json`）；`切换到此角色` = 落盘，点击先弹确认（将启用 M / 停用 N）。
  - **切换结果**：逐项结果 + 全局同名接管提示。
- 新增测试导出：`RoleRow`、`RoleEditor`、`roleStatusOf`（沿用现有 `exports.*` 测试面）。

### 单文件增长的取舍（已知代价）

角色面板约 +500~550 行，`client.js` 从 2200 涨到约 2700 行，超过「单文件 2000 行」的线。**这个文件拆不了**：`dsh.client` 只服务 `./client.js` 一个文件，且整个客户端 bundle 是手写的 lazy-CJS（`window.__ModuleLoader__.load`），**没有构建步骤**。

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
| 项目技能根不存在 | 候选为空；切换只报 `missing`，不创建目录、不复制文件 |

## 9. 测试计划（沿用现有三层）

**`test/contract.mjs`（离线，约 +40~60 项）**

- 角色 CRUD；`roles.json` 损坏时拒绝写入且原文件不动；角色数/技能数上限；重名 409；名字非法 400。
- `planRole` 纯函数：`missing` / `disable` / 软链进 `skipped` / 同名双副本一起处置 / 连切两次第二次全 `noop`。
- **`applyRole` 只动项目根**：造一个全局技能，切换后断言它的文件名与 `mtime` 一个字节没变；再造一个「plan 里塞了全局路径」的用例，断言抛 `error.path.outsideRoots`。
- 漂移：手工改一个开关 → `status === 'drifted'`。
- 激活角色被删 → `active` 失效、`status === 'unassigned'`。
- 客户端：模块表注册 id、第三个 tab 的两份 locale 齐全、缺 primitives / 缺 slots / 缺 locale 都不崩。

**`test/integration-cordis.mjs`**：在真 cordis 上按既有形状加一条 `GET /roles` 探针（`provideServices: {}`，不注入 services），断言 200 + JSON 壳，且 `data.status` 是字符串、`data.roles` 是数组、`data.candidates` 是对象。注意它读的是真实 `~/.dsh` 下的 `roles.json`：`GET` 不写盘，跑完 `~/.dsh/skill-console/` 不该多出文件。

**`test/smoke.mjs`**：只加一次**零动作角色往返**——用当前已启用的项目技能拼一个夹具角色（`zz-skill-console-smoke-role`，同名已存在即退出），`save` → `preview`（断言 `steps.length === 0`）→ `activate`（断言 `changed === 0`、`status === 'matched'`）→ `deactivate` → `remove`，最后再读一次 `/roles` 断言夹具已清掉。

为什么**不**在冒烟里测「真实的角色切换」：`smoke.mjs` 打的是用户**真实运行中的 DSH 与真实工作区**，并不存在「临时项目技能根」可建；而 `activate` 的语义就是把项目技能根里**角色外**的技能全部停用——为了验证一个接口，把用户项目里的一批技能关掉，代价与收益完全不成比例。上面这版方案仍然真走了写路径（`save`/`activate`/`remove` 都落盘），只是角色恰好等于现状，所以 `changed === 0`、盘上一个技能文件都不动。真正的对齐语义（启用/停用/软链跳过/逐项隔离/全局不可达）由 `test/contract.mjs` 在**临时目录**里覆盖——那里可以随便造技能根。

## 10. 文档与版本

- `README.md`：功能节加「角色 tab」；「三条设计边界」拆成四条，第 4 条写「角色切换只写项目技能根，全局根在结构上不可达」；「已知边界」加「全局技能无法被角色排除」与「客户端单文件超 2000 行是加载机制的结构性代价」；模块图加 `roles.js` 一行，并在文档索引处链到本文件。
- `docs/HTTP-API.md`：补 6 个端点（第 15–20 节）与 7 个 `error.role.*` 错误码到冻结契约；端点数按 `lib/routes.js` 实数（`READ_ROUTES` 8 + `WRITE_ROUTES` 12 = 20，原先 README 写的 13 与代码不符，一并改正）。
- `package.json` 版本 `0.2.1` → `0.3.0`。

## 11. 明确不做的事

- **不做切换前快照 / 一键回滚**（本期）。严格对齐一次可能停用几十个技能，但现有 `backups.js` 是「文件内容快照」，给状态对齐用会引入第二套一致性问题。等真被误切过一次再加。
- **不做「角色决定全局技能」**。技术上必须写全局根，与前提冲突。
- **不做角色继承 / 分组 / 标签**。平铺一层够用。
- **不做目录腾挪**（把技能移出技能根）。跨目录移动比 rename 危险得多，且与「绝不删、绝不改内容」的边界冲突。
- **不做自动对齐**。打开面板不会静默改盘——写操作必须由用户显式点击。
