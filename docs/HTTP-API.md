# dsh-skill-console HTTP 契约（冻结版 v1）

宿主半边（`lib/index.js`）在 `ctx.webServer` 上注册**一条 prefix 路由**：

```
kind: 'prefix'   path: '/api/skill-console'
```

所有端点路径都是 `/api/skill-console` + 下表的 `path`。

## 通用约定

- 响应体一律 JSON。
- 成功：`{ "ok": true, "data": <payload> }`
- 失败：`{ "ok": false, "code": "<机器码>", "error": "<人话>" }`，HTTP 状态码见各端点。
- **只读 GET**：无额外头要求（仍过回环围栏）。
- **写操作 POST**：必须同时带
  - `content-type: application/json`
  - `x-skill-console: 1`（跨站表单无法伪造自定义头 + JSON content-type）
  - 否则 403 / 415。
- **工作区身份 = 目录路径**（0.6.0 起）。工作区从两处来：请求里的 `project`（**工作区目录的绝对路径**），
  或 `x-skill-console-session: <sessionId>` 头（浏览器半边从 `props.useSessions`
  拿到当前会话 id 后带上）。宿主把会话解析成它的 `header.cwd`。
  **读宽松、写严格**：
  - **写接口**（`/repositories/install`、`/roles/activate`、`/roles/deactivate`、`/skills/move-to-library`、
    `/toggle`、`/toggle-batch`、`/skills/delete`）：
    请求体 `project` 优先于请求头；给了 `project` 就**只认它**——必须是**存在的工作区目录**，
    相对路径 / 不存在的路径 / 不是目录 / **不是字符串**都是 400 `error.workspace.invalid`，**绝不回落到请求头会话**
    （否则界面上选着工作区 B、写却落到 A）。只有 `project` **缺席**（或空串 `"project": ""`）时才按
    请求头会话严格解析，会话 id 不存在 / 拿不到 cwd 就是 400 `error.role.noProject`，
    **绝不回落到「最近一个会话」**。
    这些写接口都在解析出工作区之后**先判空再动手**：解析不出时**一个字节都不写**。
    **唯一的例外是 `POST /repositories/sync`（0.7.0，§13）与它带动的自动同步**：可用仓库是全局的，
    一次同步服务所有工作区，所以它刻意不看 `project`、也不校验会话头。
    （`/toggle-batch` 与 `/repositories/install` 仍在路由表里、仍有契约测试，但 0.8.0 起面板不再调用它们。）
  - **读接口**（`/state`、`/catalog`、`/roles`、`/roles/preview`、`/skill`）：`?project=<目录路径>` 优先于
    请求头，给了但无效同样是 400 `error.workspace.invalid`；**没给**时才按请求头会话宽松解析——
    解析不出会话时**回落**到「最近一个会话的 cwd」，并在 `data.project.fallback === true` 里说明。
  - `/state` 的工作区列表来自 DSH 的 `workspaceRegistry`：**注册过的工作区都在，不管它有没有活着的会话**；
    注册表不可用（拿不到 / `list()` 读失败 / `list()` 没返回数组）时退回「活着的会话按项目根去重」，
    并把 `workspacesFrom` 置成 `'sessions'`。
- 所有路径参数都是**绝对路径**，宿主会校验它落在已知技能根内，否则 400
  `error.path.outsideRoots`。前端不要自己拼路径去猜。
- 技能「根」的 key 固定为两个（`.agents` 不在本插件的管理面内，面板不扫描、也不展示）：
  | key | scope | 说明 |
  | --- | --- | --- |
  | `user-dsh` | global | `<DSH_HOME>/skills` |
  | `project-dsh` | project | `<projectRoot>/.dsh/skills` |

  两个根**都可写**（重命名发现文件实现启停）。
- 技能「状态」枚举（仓库 tab 与技能 tab 共用语义）：

  | `status` | 含义 |
  | --- | --- |
  | `not-installed` | 仓库里有、本地没装 |
  | `installed` | 已装且与仓库快照一致 |
  | `update-available` | 仓库有新内容（`installedCommit !== latestCommit`） |
  | `upstream-deleted` | 本地装过，但仓库里已经没有这个技能了 |
  | `invalid` | 本地 SKILL.md frontmatter 不合法（技能 tab 用）；仓库 tab 里只可能出现在**目录包**上——扁平候选必须 frontmatter 合法才进清单，见 `/repositories/detail` |

---

## 1. `GET /state`

环境与可选工作区。**前端首屏调用**。

```jsonc
{
  "ok": true,
  "data": {
    "version": "0.8.0",              // 插件版本（package.json 的 version）；配置页头部显示它
    "dshHome": "/Users/…/harness",
    "stateDir": "/Users/…/harness/skill-console",
    "libraryDir": "/Users/…/harness/skill-console/library",   // 可用仓库：角色的候选与复制来源（DSH 不加载它）
    "token": false,                    // 是否配了 GitHub token（只报存在性，不回显值）
    "roots": [
      { "key": "user-dsh", "scope": "global", "label": "全局 DSH",
        "path": "/Users/…/harness/skills", "exists": true, "writable": true }
      // …两个根；path 只用于定位，界面不显示绝对路径
    ],
    "workspacesFrom": "registry",      // 'registry' = 来自 DSH 工作区注册表；'sessions' = 注册表不可用，退回活着的会话
    "workspaces": [
      // 注册表里**全部**工作区（含没有活着的会话的），**顺序与注册表一致**；
      // 注册表缺席时退回「活着的会话按项目根去重」，那一版没有 workspaceId、只有 sessionId。
      // 面板侧：选项标签显示 title（注册表给的名字，缺省回落目录名），用户选过的按 `path` 认领。
      { "workspaceId": "ws-…", "path": "/Users/…/proj-a", "title": "proj-a",
        "root": "/Users/…/proj-a", "sessionIds": ["session-…"], "fromRegistry": true }
    ],
    // 当前请求头会话落在哪条工作区上（先按**目录路径**、再退回项目根匹配）：无会话时 null。
    // workspaceId 为 null = 这条只经会话头解析出来，不在注册表里。
    "selected": { "sessionId": "session-…", "cwd": "/Users/…/proj-a", "root": "/Users/…/proj-a",
                  "fallback": false, "workspaceId": "ws-…" }
  }
}
```

`workspacesFrom: 'sessions'` 时界面应说明「工作区列表来自当前活着的会话，可能不完整」；
`workspaces` 可能是空数组，此时 `selected` 仍按请求头会话给（或 `null`）。

> **叫法**：界面与文档把 `project` 统一叫「工作区」，但**契约字段名不变**——请求体 / 查询参数一律还是 `project`，错误码也照旧。

## 2. `GET /catalog?scope=all|global|project&project=<workspaceDir>`

技能目录。`scope` 取值 `all` / `global` / `project`，**缺省即 `all`**——一次回来「当前工作区的全貌」：
解析出工作区时是全局技能根 + 项目技能根两条（工作区解析不出时只有全局根）；只有显式
`?scope=global` / `?scope=project` 才收窄到一个源。
`project` 只在 `scope` 不是 `global` 时有意义（`scope=global` 时恒为 `null`）；值是**工作区目录路径**
（`?project=` 显式给了但解析不出 → 400 `error.workspace.invalid`，不回落；
没给才按会话宽松解析——解析不出就回落到「最近一个会话」）。

```jsonc
{
  "ok": true,
  "data": {
    "scope": "all",           // 缺省；显式收窄时是 'global' | 'project'
    // 给了 `?project=<目录路径>` 时是工作区形态：`sessionId` 为 null、多一个 `path`、`cwd` 就是那个目录；
    // 按请求头会话解析时则是会话形态（有 `sessionId`、没有 `path`）。`scope=global` 时为 null。
    "project": { "path": "/Users/…/proj-a", "cwd": "/Users/…/proj-a", "sessionId": null,
                 "root": "/Users/…/proj-a", "fallback": false },
    "roots": [                // scope=all 且解析出工作区时这里是两条：先全局根、后项目根
      { "key": "user-dsh", "scope": "global", "label": "全局 DSH",
        "path": "…", "exists": true,
        "skills": [
          { "name": "tdd",              // frontmatter name；缺失时回落到目录/文件名
            "declaredName": "tdd",      // frontmatter 里真正写的 name（可为 null）
            "description": "Test-driven development…",
            "path": "/Users/…/harness/skills/tdd/SKILL.md",   // 当前发现文件（可能是 .disabled）
            "directory": "/Users/…/harness/skills/tdd",
            "kind": "directory",        // 'directory' | 'flat'
            "enabled": true,
            "diagnostics": [ { "code": "diagnostic.name.invalid", "message": "…" } ],
            "size": 1234,
            "mtimeMs": 1789…,
            "installed": { "id": "obra/superpowers", "owner": "obra", "name": "superpowers",
                           "commit": "abc1234", "sourcePath": "skills/tdd" }, // 非订阅安装时为 null
            "inRole": false,            // 当前角色的技能集里有同名？（0.8.0；角色未分配时恒 false）
            "inLibrary": true           // 可用仓库里有同名？（0.8.0）
          }
        ] }
    ],
    "collisions": [
      { "name": "tdd",
        "winner": { "root": "project-dsh", "path": "…" },
        "shadowed": [ { "root": "user-dsh", "path": "…" } ] }
    ],
    "warnings": [ { "code": "error.root.read", "message": "…" } ]
  }
}
```

> 排序：`roots` 按上表顺序；每个根内技能按 `name` 升序。
> `collisions` 只列**多个根里同名且都启用**的技能（这正是「关掉项目副本后全局副本接管」要在 UI 上讲清楚的地方）。

## 3. `GET /skill?path=<abs>`

读单个技能正文（**禁用状态也能读**）。`?project=<workspaceDir>` 优先于 `x-skill-console-session` 头，
按**读路径**处理：给了就是工作区目录路径（无效 → 400 `error.workspace.invalid`）；
没给才按会话宽松解析（解析不出就回落到「最近一个会话」的项目技能根）。

```jsonc
{
  "ok": true,
  "data": {
    "name": "tdd", "declaredName": "tdd", "description": "…",
    "path": "…", "enabled": true, "kind": "directory",
    "frontmatter": "name: tdd\ndescription: …",   // 去掉 --- 围栏后的原始 YAML 文本
    "body": "# tdd\n…",                            // 去掉 frontmatter 的正文
    "diagnostics": [ … ], "size": 1234, "mtimeMs": 1789…,
    "inRole": false,      // 当前角色的技能集里有同名？（0.8.0；角色未分配时恒 false）
    "inLibrary": true     // 可用仓库里有同名？（0.8.0）
  }
}
```
错误：404 `error.skill.notFound`；400 `error.path.outsideRoots`。

## 4. `POST /toggle`

```jsonc
// 请求（project 省略时按请求头解析的会话；project 是工作区目录路径，给了就只认它）
{ "path": "/Users/…/harness/skills/tdd/SKILL.md", "enabled": false, "project": "/Users/…/proj-a" }
// 响应 data
{ "skill": { …与 /catalog 里的技能条目同形… },
  "takeover": [ { "root": "user-dsh", "label": "全局 DSH", "scope": "global", "path": "…" } ],
  "changed": true }   // 关掉后接管同名技能的其他已启用副本（enabled=true 时 takeover 恒为 []）
```
语义：**只重命名发现文件**，绝不改写内容。
- `project` 是**工作区目录路径**，给了就只认它（不是存在的目录 → 400 `error.workspace.invalid`）；
  没给才按 `x-skill-console-session` 头严格解析，解析不出 → 400 `error.role.noProject`。
  两种失败都**一个字节都不写**。
- 禁用：`SKILL.md` → `SKILL.md.disabled`；`<name>.md` → `<name>.md.disabled`
- 启用：反向。
- 目标已存在时 409 `error.toggle.conflict`（不覆盖任何东西）。
- 路径不在已知技能根内 → 400 `error.path.outsideRoots`。
- 发现文件不存在 → 404 `error.toggle.notFound`。

## 5. `POST /toggle-batch`

```jsonc
// 请求（project 省略时按请求头解析的会话；project 是工作区目录路径）
{ "items": [ { "path": "…", "enabled": false }, … ], "project": "/Users/…/proj-a" }   // 最多只处理前 200 项：items.slice(0, 200)，其余静默丢弃（不分片、不报错）
// 上限是**每次请求**的：客户端按技能根/按仓库分组各发一次请求，单个组自身超过 200 项时同样会被截断。
// 响应 data
{ "results": [ { "path": "…", "ok": true }, { "path": "…", "ok": false, "error": "…" } ],
  "changed": 1 }
```
`project` 是**工作区目录路径**，给了就只认它（无效 → 400 `error.workspace.invalid`）；
没给才按 `x-skill-console-session` 头严格解析，解析不出 → 400 `error.role.noProject`。
两种失败都**一个字节都不写**（不会退化成「逐项 `ok:false`」的静默失败）。

> 0.8.0 起面板**不再调用这个端点**：根头 / 仓库组头的「全部启用 / 全部停用」整层撤掉，逐项
> `POST /toggle` 是唯一入口。端点本身保留（契约测试仍在跑），删不删待单独清理。

## 6. `GET /repositories`

订阅列表 + 每个订阅的汇总状态。

```jsonc
{
  "ok": true,
  "data": {
    "token": false,
    "repositories": [
      { "id": "obra/superpowers",           // 规范 id：owner/name
        "owner": "obra", "name": "superpowers",
        "url": "https://github.com/obra/superpowers",
        "ref": "",                          // '' = 默认分支
        "subdirectory": "skills",           // '' = 仓库根
        "addedAt": 1789…,
        "lastFetch": { "at": 1789…, "commit": "abcdef1234…", "commitShort": "abcdef1",
                       "commitMessage": "…", "commitDate": "2026-09-21T…Z",
                       "skillCount": 12, "error": null },   // 从未拉取时 null
        // 计数含 invalid / localModified / conflict 三项（非 0 时界面要提示）
        "status": { "total": 12, "notInstalled": 10, "installed": 1,
                    "updateAvailable": 1, "upstreamDeleted": 0, "localModified": 1 },
        // 可用仓库台账汇总（0.7.0；只比 commit，不读盘）——卡片状态行显示的就是它
        "library": { "count": 12, "synced": 10, "outdated": 2, "orphan": 0 } }
    ]
  }
}
```

## 7. `POST /repositories/add`

```jsonc
// 请求（url 支持 https://github.com/owner/name、github.com/owner/name、owner/name）
{ "url": "obra/superpowers", "ref": "", "subdirectory": "skills" }
// 响应 data：添加后立刻做一次初始拉取（这不是「更新」，是首次发现），并**顺带同步进可用仓库**
{ "repository": { …同上 repositories[] 条目… },
  "skills": [ …见 /repositories/detail 的 skills… ],
  "fetchError": null,                        // 拉取失败时订阅仍保留，原因在这里
  "sync": { "synced": [ …同 §13… ], "unchanged": [ "…" ], "skipped": [ … ] },   // 0.8.0：自动同步的回执
  "syncError": null }                        // 同步失败不回滚订阅，原因在这里
```
错误：400 `error.repo.url`（解析不出 owner/name）、409 `error.repo.exists`、
502 `error.repo.network` / `error.repo.notFound` / `error.repo.rateLimit`。

## 8. `POST /repositories/update`  ← 编辑订阅（分支 / 子目录）

```jsonc
{ "id": "obra/superpowers", "ref": "v1.2.3", "subdirectory": "skills" }
// data: { "changed": true, "repository": { … }, "skills": [ … ], "fetchError": null,
//         "sync": { "synced": [], "unchanged": [ … ], "skipped": [] }, "syncError": null }
```
语义：只改**分支/标签**与**子目录**——`owner/name` 是订阅的身份，换仓库必须走
「移除订阅 + 添加」。分支/子目录真的变了就**丢弃旧清单并立刻重拉**（旧清单属于
另一棵目录树，继续用会让「安装」装错东西）；重拉失败时订阅设置照常保存，
失败原因放在 `fetchError` 里。`changed:false` 表示没有改动（此时不重拉）。
错误：400 `error.proto.missingId` / `error.repo.subdirectory`、404 `error.repo.unknown`。

## 9. `POST /repositories/remove`

```jsonc
{ "id": "obra/superpowers" }
// data: { "removed": "obra/superpowers", "installedKept": ["tdd", …] }
```
**只删订阅记录，已安装到本地的技能原样保留**（这是刻意的：卸载订阅 ≠ 删技能）。

## 10. `POST /repositories/fetch`  ← 手动「拉取最新」

```jsonc
{ "id": "obra/superpowers" }
// data: { "repository": { … }, "skills": [ …同 detail… ], "commit": "def5678",
//         "sync": { "synced": [], "unchanged": [ … ], "skipped": [] }, "syncError": null }
```
语义：刷新**远端清单**（写 `<DSH_HOME>/skill-console/repository-cache/`），并**顺带同步进可用仓库**
（0.8.0 起，`fetchAndSync`；同步失败只回 `syncError`，不推翻这次拉取）。
**不碰任何技能根**：本地已装技能一个字节不变，装不装由用户另说（面板已不再提供安装入口）。

## 11. `GET /repositories/detail?id=<owner/name>`

```jsonc
{
  "ok": true,
  "data": {
    "repository": { … },
    "skills": [
      { "sourcePath": "skills/tdd",              // 仓库内相对路径
        "name": "tdd",                           // frontmatter name（非法时为 null）
        "description": "…",
        "valid": true,
        "diagnostics": [ … ],
        "status": "update-available",   // 见下方状态机（含 invalid）
        "installedPath": "/Users/…/harness/skills/tdd",   // 未安装时 null
        "installedCommit": "abc1234",
        "latestCommit": "def5678",
        "localModified": false,                  // 本地文件与安装快照不一致
        "changedFiles": [ { "path": "SKILL.md", "change": "modified" },
                          { "path": "extra.md", "change": "added" } ],
        "files": 7, "bytes": 48213,              // 远端清单里的规模（files 不含目录）
        "conflict": false,                        // 本地已有同名技能，但不属于本订阅
        "requiresConfirm": false,                 // conflict || (update-available && localModified)
        "library": { "state": "synced",           // 可用仓库里那份的状态（0.7.0）；
                                                    // missing / synced / modified / outdated / orphan(清单里已没有)
                     "commit": "def5678", "syncedAt": 1789… } }
    ],
    "fetched": true                               // 远端清单是否存在过（与 skills 为空是两件事）
  }
}
```

清单里**只会出现真技能**：目录包（基目录下 `<dir>/SKILL.md`）一律收录，扁平文件
（基目录下 `<name>.md`）必须 frontmatter 合法才收录——否则订阅任意仓库根时，
`README.md` / `CONTRIBUTING.md` 这类文档会被当成「frontmatter 不合法的技能」刷屏。
所以 `skills: []` + `fetched: true` 是一个**有意义的状态**：拉取成功但这一层没有技能，
最常见的原因是 `subdirectory` 没指到放技能的那一层，界面据此提示用户去改子目录
（见 `/repositories/update`）。

## 12. `POST /repositories/install`  ← 安装 / 更新

```jsonc
// 请求（target 省略或非 'project' 一律按 'global' 处理；project 只在 target:'project' 时有意义）
{ "id": "obra/superpowers", "skills": ["tdd", "brainstorming"], "confirm": false,
  "target": "project", "project": "/Users/…/proj-a" }
// data
{ "installed": [ { "name": "tdd", "path": "…", "updated": true,
                   "backup": "/Users/…/skill-console/backups/tdd/1789…" } ],
  "skipped":   [ { "name": "x", "reason": "local modifications: pass confirm:true" } ] }
```
语义（写死的边界，README 里也要写）：
- `target` **只认 `"project"`**；缺省或其它任何值一律按 `"global"` 处理（向后兼容）。
- `global` → `<DSH_HOME>/skills/<name>`（与 0.3.0 完全一致）；`project` → `<projectRoot>/.dsh/skills/<name>`（根不存在时随写入创建）。
- 装到 `project` 时，目标位置已有同名技能就**一律**要 `confirm:true` 才覆盖：订阅快照只描述全局那一份，不能用来证明项目这份没被改过。
- 装到 `project` **不更新订阅快照**（台账只记全局那份），也不写别的 Agent 目录。
- 装到**哪个工作区**由请求体 `project`（**工作区目录路径**）指定，给了就**只认它**（不是存在的目录 →
  400 `error.workspace.invalid`）；没给才按 `x-skill-console-session` 头严格解析，解析不出就 400
  `error.role.noProject`——**不会回落到「最近一个会话」，也不会静默退回全局**。
- 一次安装的技能数 **> 200** → 400 `error.proto.tooMany`（**硬拒、一个字节不写**）。这与 `/toggle-batch`
  的静默截断**不对称**：批量启停把超出的丢掉照样 200，安装则直接报错——安装要建目录、要备份，静默少装一半更危险。
- 覆盖前把旧目录整份复制到 `<DSH_HOME>/skill-console/backups/<name>/<ts>/content/`，
  并把 `files` 快照（`相对路径 → git blob SHA-1`，即 `sha1("blob <len>\0" + bytes)`）记进订阅状态。
- 上一版快照里有、新清单里没有的文件会被删除（真正的同步），因此**必须先备份**。
- `status` 为 `installed` 且 `localModified` 为 true 时，必须 `confirm:true` 才覆盖；
  否则该技能进 `skipped`。
- 写入是**目录级原子**的：先在 `skill-console/staging/` 里搭好整棵树，再整体 `rename`
  到位——中途失败时目标要么是旧版本、要么是新版本，不会是半截。
- 下载字节逐个用 git blob SHA-1 与 tree 快照比对，对不上就整项失败、不落盘。
- 安装完成后宿主会让技能注册表失效（下一次 `agent/pre-step` 就能看到新目录）。
- 想一次把清单里能用的技能都取到本地、**不碰任何技能根**（只给角色当候选与复制来源）时，用 §13 的
  `POST /repositories/sync`——安装是「装进技能根」，同步是「放进可用仓库」，两者互不影响。
- **0.8.0 起面板不再暴露这个端点**：仓库卡上的「安装到…」选择器、逐项勾选与安装按钮整块撤掉
  （往项目里放技能改走角色切换；全局技能根由「移到可用仓库」往外搬）。端点与它的测试仍在。

## 13. `POST /repositories/sync`  ← 同步到可用仓库（0.7.0）

把一个订阅**当前清单里的全部合法技能**落到**可用仓库**（`<DSH_HOME>/skill-console/library/`）——
角色的候选与复制来源就是它（见 §16）。**一次同步整个清单，不接受技能名列表。**

> 0.8.0 起这是**补齐用的端点**：`POST /repositories/add`、`POST /repositories/update`（分支/子目录真的变了时）
> 与 `POST /repositories/fetch` 都会自动同步（`fetchAndSync`），它们的响应里带 `sync` / `syncError`。
> 只有「库里的文件被手工删掉 / 之前同步失败 / 想显式确认覆盖」时才需要直接调它。

```jsonc
// 请求：id 必填；confirm 省略 = false
{ "id": "obra/superpowers", "confirm": false }
// data
{ "synced":    [ { "name": "tdd", "path": "/Users/…/library/tdd", "updated": false, "backup": null } ],
  "unchanged": [ "brainstorming" ],     // 库里已与清单一致、且没被本地改过 → 一个字节都没写
  "skipped":   [ { "name": "x",
                   "reason": "local modifications detected; pass confirm:true to overwrite (a backup is taken)" } ] }
```

语义（写死的边界，README 里也要写）：
- **只写可用仓库，不碰任何技能根**：`<DSH_HOME>/skills` 与 `<projectRoot>/.dsh/skills` 一个字节不变，
  技能注册表也**不**失效（库不在 DSH 的加载路径上，DSH 永远不会加载它）。
- **库是全局的**：这个端点**不读工作区**——不看请求体 `project`、也不校验 `x-skill-console-session`
  （唯一的例外写接口），一次同步对**所有**工作区生效。
- **幂等**：清单里每个技能，若库里的快照 `commit` 与清单一致、且文件没被本地改过 → 进 `unchanged`，
  **不下载、不写盘**（连 mtime 都不动）。再点一次同步不会有任何写动作。
- **保护本地改动**：库里的文件与其快照对不上时，该技能默认进 `skipped` 并给出
  `local modifications detected…`；`confirm:true` 才覆盖，覆盖前把旧版本整份备份到
  `<DSH_HOME>/skill-console/backups/<name>/<ts>/`（与安装共用同一套备份与「本地改动」判据）。
- 清单缓存（`repository-cache/`）丢了也能同步：先自动按当前分支重新拉取一次清单再落盘。
- 上游已删除的技能**不会被清出库**（不自动清理），所以卡片上「可用仓库里有 N 个」可能大于
  「与最新清单一致 + 不一致」之和。
- 落盘与安装同样**目录级原子**（staging → rename）、下载字节逐个比对 git blob SHA-1；
  frontmatter 非法的技能直接进 `skipped`。
- 同步台账记在订阅状态里（`repositories.json` 的 `record.library`），与「安装到技能根」的
  `record.skills` **互不影响**；`/repositories/remove` 只删订阅记录，库里的文件留着。
- 错误：`id` 缺失/非法 → 400 `error.proto.missingId`；订阅不存在 → 404 `error.repo.unknown`；
  订阅状态文件损坏 → 500 `error.repo.state`；逐项下载/校验失败进 `skipped` 或整项报 `error.install.*`。

## 14. `GET /backups?name=<skill>`

```jsonc
// name 省略 = 列出全部技能的备份
{ "ok": true,
  "data": { "backups": [ { "name": "tdd", "id": "1789…",
                           "path": "/Users/…/backups/tdd/1789…",
                           "at": 1789…, "files": 7,
                           "kind": "directory", "target": "/Users/…/skills/tdd" } ] } }
```

## 15. `POST /restore`

```jsonc
{ "name": "tdd", "backup": "1789…" }   // backup 省略 = 最近一次备份
// data: { "name": "tdd", "backup": "1789…", "path": "…", "restored": true }
```
语义：把备份整份复制回 `<DSH_HOME>/skills/<name>`（先给当前版本再备份一次，保证可回退）。
错误：404 `error.backup.notFound`。

---

## 角色（技能组合）

角色是一条**只在项目技能根上落盘**的支线：读端点看角色清单与对齐状态，写端点先只改
`<DSH_HOME>/skill-console/roles.json`，只有 `/roles/activate` 会重命名项目根里的发现文件。
全局技能根（`user-dsh`）在这条线上的路径**既不读也不写**、结构上不可达（`applyRole` 只接受单个项目根）。
**角色的候选只有一个来源：可用仓库**（§13 同步出来的那份）——候选与当前工作区、与全局技能根都无关，
切换时「项目里没有、库里有」的技能从库里复制进项目。

## 16. `GET /roles`

角色清单 + 本项目激活角色 + 对齐状态。**只读**。

```jsonc
// 读接口：?project=<workspaceDir>（工作区目录路径，无效即 400）优先于 x-skill-console-session 头；
// 没给 project 且会话也解析不出时回落最近一个会话，并把 project.fallback 置为 true
// （这是**读路径**：写路径只认请求体 project / 请求头且严格解析，见 §12、§20、§21、§23）
{
  "ok": true,
  "data": {
    "roles": [ { "id": "…", "name": "前端", "skills": ["a", "b"], "updatedAt": 1789…, "active": false } ],
    "active": { "id": "…", "name": "前端" },      // 本项目未激活角色时 null
    "project": { "name": "proj-a", "fallback": false },   // 解析不出项目根时 null
    "status": "unassigned",                        // 'unassigned' | 'matched' | 'drifted'
    "stats": { "inRole": 2, "total": 7, "copy": 0, "enable": 0, "disable": 0, "noop": 5, "skipped": 0, "missing": 0, "localKept": 0 },
    "localKept": [ { "name": "g", "projectPath": "…/g/SKILL.md", "libraryPath": "…/library/g/SKILL.md" } ],
    // 候选 = 可用仓库里的技能（0.7.0 起是**平面数组**，不再分 project/global）
    "candidates": [ { "name": "g", "path": "…/library/g", "enabled": true, "toggleable": true, "readOnlyReason": null } ],
    // 本项目技能根现状，只用于算「● 已启用 / ○」与数量，**不参与勾选与对齐**
    "projectSkills": [ { "name": "a", "path": "…/.dsh/skills/a", "enabled": true, "toggleable": true, "readOnlyReason": null } ],
    "library": { "path": "/Users/…/harness/skill-console/library", "count": 3 }
  }
}
```

- `status`：无激活角色 → `unassigned`；`planRole` 的 `steps` 为空 → `matched`；否则 `drifted`。
  `missing` **不影响** `status`（只是「角色里有、本项目没有」）。
- `drifted` **不自动纠正**：手工改过开关就一直显示「已偏离」，等用户主动再切一次。
- `candidates` 是**平面数组**（只来自可用仓库），每项只带 `name` / `path` / `enabled` / `toggleable` /
  `readOnlyReason`；勾选的含义是「切换时把**库里那份复制进项目**」。能不能操作一律由 `toggleable`
  表达（软链技能是 `toggleable: false` + `readOnlyReason: 'symlink'`）。**项目技能与全局技能都不在候选里。**
- `projectSkills` 是本项目技能根的现状（同形状）：界面只用它算行首的 `●`（本项目已启用）/ `○`
  与 `stats.total`，**不参与勾选与对齐**。
- `library` 是可用仓库的位置与技能数，供界面讲「候选从哪来」；`library.path` 只用于定位，界面不显示绝对路径。
- `stats.copy`：角色里要、项目里没有、**库里有**的技能数量——切换时会把它们从库复制进项目根（复制出来一律启用态）。
- `stats.localKept` / 顶层 `localKept`：项目里已有同名的条目；**保留项目那份，绝不被库覆盖**，该条目自身该 enable / disable / noop 照旧。`localKept` 不计入 `stats.total`。
- `stats.missing`：角色里要、项目与可用仓库都没有的名字数量；只报告，不算失败，也不影响 `status`。
- 错误：500 `error.role.state`（`roles.json` 损坏，拒绝覆盖）。

## 17. `GET /roles/preview?role=<id>`

切换会做什么。**只读，绝不落盘**——就是 `planRole` 的产物加角色信息。

```jsonc
{
  "ok": true,
  "data": {
    "role": { "id": "…", "name": "前端" },
    "status": "drifted",
    "steps":   [ { "name": "b", "path": "…", "action": "enable", "current": false, "target": true },
                 { "name": "g", "path": null, "action": "copy", "current": false, "target": true,
                   "sourcePath": "…/g/SKILL.md", "sourceKind": "directory" } ],
    "noop":    [ { "name": "a", "path": "…", "enabled": true } ],
    "skipped": [ { "name": "s", "path": "…", "reason": "symlink" } ],
    "localKept": [ { "name": "k", "projectPath": "…/k/SKILL.md", "libraryPath": "…/library/k/SKILL.md" } ],
    "missing": ["在其他项目里才有的技能"],
    "stats":   { "total": 8, "copy": 1, "enable": 1, "disable": 0, "noop": 5, "skipped": 1, "missing": 1 }
  }
}
```
错误：400 `error.proto.missingId`（缺 `role` 参数）、404 `error.role.unknown`。

## 18. `POST /roles/save`  ← 新建 / 更新角色

```jsonc
// 请求（id 省略 = 新建）
{ "id": "…", "name": "前端", "skills": ["a", "b"] }
// 响应 data
{ "role": { "id": "…", "name": "前端", "skills": ["a", "b"], "updatedAt": 1789… } }
```
语义：**只写 `roles.json`，一个技能文件都不碰**。`skills` 存技能名（不存路径），所以角色
跨项目可复用；本项目没有的名字由 `/roles` 报成 `missing`。`skills` 会去重。
错误：400 `error.role.name`（名字空/超 60 字）、400 `error.role.skills`（不是字符串数组）、
400 `error.role.tooMany`（角色数 > 50 或每角色技能数 > 200）、409 `error.role.duplicate`（重名）、
404 `error.role.unknown`（带了不存在的 `id`）、500 `error.role.state`。

## 19. `POST /roles/remove`

```jsonc
{ "id": "…" }
// data: { "removed": "…", "clearedProjects": ["/abs/project-root"] }
```
**只删角色记录，磁盘上的技能文件一个都不动**；指向它的激活记录一并清掉并逐条列入
`clearedProjects`。错误：400 `error.proto.missingId`、404 `error.role.unknown`、500 `error.role.state`。

## 20. `POST /roles/activate`  ← 对齐（唯一破坏性的角色操作）

```jsonc
// 请求：project（工作区目录路径，要操作哪个工作区）给了就只认它；没给才按 x-skill-console-session 头解析
{ "id": "…", "project": "/Users/…/proj-a" }
// data
{ "role": { "id": "…", "name": "前端" },
  "status": "matched",                       // 逐项失败时 'drifted'
  "results": [ { "name": "b", "path": "…", "action": "enable", "ok": true, "enabled": true, "changed": true },
               { "name": "c", "path": "…", "action": "disable", "ok": false, "code": "error.toggle.notFound", "error": "…" } ],
  "changed": 1,
  "takeover": [ { "name": "c", "by": [ { "root": "user-dsh", "label": "全局 DSH", "scope": "global", "path": "…" } ] } ],
  "localKept": [ { "name": "k", "projectPath": "…/k/SKILL.md", "libraryPath": "…/library/k/SKILL.md" } ] }
```
语义：严格对齐——角色内的启用、项目里其余的全部停用（复用 `/toggle` 的发现文件重命名），
角色里要、项目里没有、全局有的技能**先从全局复制进项目**（`action: 'copy'`，复制出来一律启用态），
**只写项目技能根**，全局根在结构上不可达。逐项隔离：一项失败不影响其余项。
`changed > 0` 时让技能注册表失效，并对每个真正改动的路径各发一次 `fs/observed` 通知。
`takeover` 报告「停用项目副本后，全局同名技能接管生效」；`localKept` 报告「两边同名、保留项目那份」。
写的是**哪个工作区**：请求体 `project`（**工作区目录路径**）给了就只认它，不是存在的目录 →
400 `error.workspace.invalid`；没给才按 `x-skill-console-session` 头严格解析，解析不出
（会话不存在 / 拿不到 cwd）→ 400 `error.role.noProject`，**绝不回落到「最近一个会话」**。

错误：400 `error.proto.missingId`、400 `error.role.noProject`（没给 project 且解析不出会话）、
400 `error.workspace.invalid`（给了 project 但不是存在的目录）、
404 `error.role.unknown`、500 `error.role.state`。

## 21. `POST /roles/deactivate`

```jsonc
{ "project": "/Users/…/proj-a" }   // 清掉本项目「激活了哪个角色」的记录；project（工作区目录路径）可省略（省略时按请求头解析）
// data: { "cleared": true }   // 本来就没记录时 false
```
**只清记录，不动磁盘**：技能保持现状，不还原成切换前的样子（当前没有快照/回滚）。
本端点**会读请求体**：`project`（**工作区目录路径**）给了就只认它（无效 → 400 `error.workspace.invalid`）；
没给才按 `x-skill-console-session` 头严格解析，解析不出 → 400 `error.role.noProject`，
**不会回落到「最近一个会话」**。
错误：400 `error.role.noProject`、400 `error.workspace.invalid`、500 `error.role.state`。

## 22. `POST /skills/delete`  ← 删除技能（破坏性，先备份）

```jsonc
// 请求（发现文件的绝对路径，可能是 .disabled；project 省略时按请求头解析的会话）
{ "path": "/Users/…/.dsh/skills/tdd/SKILL.md", "project": "/Users/…/proj-a" }
// data
{ "name": "tdd", "path": "…/tdd/SKILL.md", "kind": "directory", "form": "directory",
  "root": "user-dsh", "directory": "…/tdd", "backup": "…/backups/tdd/1789…",
  "removed": ["…/tdd"], "deleted": true }
```
语义（顺序是硬要求）：
- `project` 是**工作区目录路径**，给了就只认它（无效 → 400 `error.workspace.invalid`）；
  没给才按 `x-skill-console-session` 头严格解析，解析不出 → 400 `error.role.noProject`。
  两种失败都**一个字节都不写**（连备份都不会创建）。
- 先围栏（400 `error.path.outsideRoots`）与存在性检查（404 `error.skill.notFound`）；缺 `path` → 400 `error.proto.missingPath`。
- **先整份备份**：目录包备份整个包目录（含内部脚本/resources），扁平文件备份那一个文件，软链接只存链接本身（`meta.json` 记 `link`）。备份抛错 → 500 `error.delete.backup`，**一个字节都不删**。
- 再删：目录包 `rmSync(directory, {recursive:true})`；扁平删那个文件；软链接只 `unlinkSync` 链接本身，**绝不 dereference**。
- `form` 是实际落盘形态（`directory` / `flat` / `symlink`）；`kind` 仍是 `directory` / `flat`。
- **技能根本身永远不会被删**（删除目标只可能来自扫描到的发现文件）。
- 成功 200；恢复走 `GET /backups` + `POST /restore`。

## 23. `POST /skills/move-to-library`  ← 把技能搬进可用仓库（破坏性，先备份）

```jsonc
// 请求：全局技能根或当前工作区项目技能根里的发现文件路径；project 只在来源是项目技能时才有意义
{ "path": "/Users/…/.dsh/skills/tdd/SKILL.md", "project": "/Users/…/proj-a" }
// data
{ "name": "tdd", "from": "/Users/…/.dsh/skills/tdd/SKILL.md", "to": "/Users/…/library/tdd",
  "kind": "directory", "backup": "…/backups/tdd/1789…", "sourceRemoved": true }
// 删原处失败时：{ …, "sourceRemoved": false, "warning": "库里已经就位，但原处那份没删掉：…" }
```
语义：
- 来源**两个技能根都行**（全局或当前工作区项目技能根）——0.7.0 之前这条只允许全局 → 项目，0.8.0 起
  统一成「搬进可用仓库」。软链接 400 `error.transfer.symlink`；**库里已有同名技能名** 409
  `error.transfer.exists`（**按技能名判**，不按目标路径；不覆盖、不备份、不动手）。
- 落进**哪个工作区**由请求体 `project`（**工作区目录路径**）决定（来源是项目技能时必需），给了就只认它
  （无效 → 400 `error.workspace.invalid`）；没给才按 `x-skill-console-session` 头严格解析，解析不出项目根
  400 `error.role.noProject`，**不会回落到「最近一个会话」**。
- 顺序：① 备份原处那份（失败 → 500 `error.delete.backup`，什么都不移）② 复制进库 ③ 删原处那份。
- **③ 失败不回滚**：库里那份留着，响应 `sourceRemoved:false` + `warning` 如实报告；再点一次「删除」即可清掉原处那份。
- 复制失败时按复制自身的错误码上抛（`error.copy.exists` 409 / `error.transfer.symlink` 400 / `error.skill.notFound` 404），此时原处没动。
- `to` 是**目标技能路径**（目录包给目录、扁平给 `.md` 文件）；`from` 是原发现文件路径；`kind` 是源技能形态（`directory` / `flat`）。
- 面板上这个按钮**有条件出现**（0.8.0）：技能已在当前角色里（`inRole`）或已在可用仓库里（`inLibrary`）时不显示。

---

## 前端必须处理的错误码

| code | UI 动作 |
| --- | --- |
| `error.path.outsideRoots` | 提示「该路径不在已知技能根内」，不重试 |
| `error.toggle.conflict` | 提示同名目标已存在，建议刷新 |
| `error.toggle.symlink` | 提示软链接技能不可启停（重命名会改到链接目标），并禁用开关 |
| `error.repo.url` | 提示地址解析不出 `owner/name` |
| `error.repo.exists` | 提示已经订阅过该仓库 |
| `error.install.verify` | 提示下载内容与仓库快照不一致（网络/代理改写了内容），可重试 |
| `error.repo.rateLimit` | 提示配 GitHub token（环境变量 `DSH_SKILL_CONSOLE_GITHUB_TOKEN` / `GITHUB_TOKEN`） |
| `error.repo.network` | 提示网络失败，可重试 |
| `error.backup.notFound` | 提示没有可恢复的备份 |
| `error.role.state` | 角色状态文件（`<DSH_HOME>/skill-console/roles.json`）损坏：**拒绝覆盖**，提示用户备份后手工修或删除 |
| `error.role.unknown` | 角色不存在（可能已在别处删掉），提示刷新角色列表 |
| `error.role.name` | 角色名为空或超过 60 字 |
| `error.role.duplicate` | 角色重名，提示换个名字 |
| `error.role.tooMany` | 角色数或每角色技能数超出上限（角色 > 50 / 每角色技能 > 200） |
| `error.proto.tooMany` | 一次安装的技能数 > 200（`/repositories/install`）：**硬 400**，与 `/toggle-batch` 的静默截断不同 |
| `error.role.skills` | `skills` 不是字符串数组 |
| `error.workspace.invalid` | 请求里**显式给的** `project`（工作区目录路径）解析不出（不存在 / 不是目录 / 相对路径）：提示这个工作区已经不在磁盘上，刷新工作区列表重新选；**绝不退回请求头会话** |
| `error.role.noProject` | 写接口**没给** `project`，且请求头会话也解析不出（会话 id 不存在 / 拿不到 cwd，**绝不回落到最近会话**），或角色只能落在项目根上却没有项目目录：提示先打开 / 选对一个工作区 |
| `error.delete.backup` | 删除/移动前的备份失败：**什么都没改**，提示看日志后重试 |
| `error.copy.exists` | 复制/移动的目标位置已有同名技能，拒绝覆盖 |
| `error.transfer.exists` | **可用仓库**里已有同名技能，移动拒绝覆盖（先自己决定留哪一份） |
| `error.transfer.symlink` | 软链接技能不能复制/移动（会动到链接目标） |
| `error.internal` | 后端抛异常（未改动任何文件）；提示看 DSH 日志的 web-server 警告 |
| `error.endpointMissing` | **不是服务端码**：客户端在响应体不是 JSON 壳时自行合成，说明请求没走到本插件（插件未加载 / 未重启） |
| 其他 | 直接展示 `error` 文本 |

### 永远不会出现的响应：裸 400

宿主 webserver 对「handler 抛异常」的反应是回 **一个没有正文的 400**，客户端无法区分它和
网关错误。所以宿主入口在最外层兜底：任何逃逸异常都转成 `500 {ok:false, code:'error.internal'}`，
本插件的每一个响应都是 JSON 壳、都带 `code`。**看到裸文本 `unauthorized` / `not found` / 空 400
就说明请求没走到本插件**，客户端据此给出 `error.endpointMissing` 而不是干巴巴的 `HTTP 401`。

## 诊断码（`diagnostics[]` 的元素）

`diagnostics` 是**裸码字符串数组**（不是对象）：宿主只回机器码、不回中文，
界面按码本地化。未知码一律直接显示码本身。

| code | 含义 |
| --- | --- |
| `diagnostic.frontmatter.missing` | 文件第一行不是 `---`（没有 frontmatter 围栏） |
| `diagnostic.frontmatter.unclosed` | 有开头围栏但没有结束围栏 |
| `diagnostic.frontmatter.invalid` | 围栏里有行既不是键值对也不是缩进续行 |
| `diagnostic.name.missing` | frontmatter 里没有 `name` |
| `diagnostic.name.invalid` | `name` 不符合 kebab-case 语法 |
| `diagnostic.description.missing` | 没有 `description`（DSH 要求必须有） |
| `diagnostic.symlink` | 技能是软链接，**不允许启停** |
| `error.file.read` | 读文件本身失败（权限、编码、断链等） |

## 文件系统副作用清单（给 UI 文案用）

宿主只动这几个地方：

1. 技能根里的**发现文件重命名**（`SKILL.md` ↔ `SKILL.md.disabled`、`*.md` ↔ `*.md.disabled`）：
   两个技能根（项目根、全局根）都能做，但 `/roles/activate` **只写项目根**——全局根在角色链路上既不读也不写
2. 仓库安装/更新的目标（`/repositories/install`，0.8.0 起面板不再调用）：缺省 `<DSH_HOME>/skills/<name>/`；`target:'project'` 时是当前工作区的项目根下的 `.dsh/skills/<name>/`（根不存在会随写入创建）
2.1. 自动同步与 `POST /repositories/sync` 的目标：`<DSH_HOME>/skill-console/library/<name>/`（可用仓库；只被角色读到、DSH 不加载）
3. `<DSH_HOME>/skill-console/repositories.json`（订阅与安装快照）
4. `<DSH_HOME>/skill-console/roles.json`（角色定义 + 每个项目激活了哪个角色；`/roles/save`、`/roles/remove`、`/roles/deactivate` **只写这一个文件**，不动任何技能）
5. `<DSH_HOME>/skill-console/repository-cache/` 与 `backups/`
6. `POST /skills/delete`：先整份备份，再删发现文件所在的整包（目录包）／那个文件（扁平）／链接本身（软链接）；技能根本身永远不删
7. `POST /skills/move-to-library`：先备份原处那份 → 复制进可用仓库 → 删原处那份；删原处失败不回滚（库里那份留着，如实报 `warning`）
8. `POST /repositories/install` 的 `target:'project'`：只写当前工作区的项目技能根 `<projectRoot>/.dsh/skills/`，不更新订阅快照
9. `POST /repositories/sync`：只写可用仓库 `<DSH_HOME>/skill-console/library/` 与订阅状态里的 `record.library` 台账；**不写任何技能根**，也不让技能注册表失效

除此之外不写任何文件；不会自动删技能——删除／移动只在你显式调用时发生，且删前必先备份。
