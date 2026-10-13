# 技能根与写盘语义（`lib/roots.js`）

状态：**已实现**（`dsh-skill-console@0.6.0`）。本文件描述 `dsh-plugin/lib/roots.js` **当前**的行为：两个技能根的解析、发现规则，以及三个写盘入口的围栏与软链接处置。端点级契约见 `docs/HTTP-API.md`；角色那条线见 `docs/readme/roles.md`。

---

## 1. 两个技能根

| key | scope | 路径 |
| --- | --- | --- |
| `user-dsh` | global | `<DSH_HOME>/skills`（`$DSH_HOME`，空白视为未设置，回落 `~/.dsh`） |
| `project-dsh` | project | `<projectRoot>/.dsh/skills` |

- 项目根 = 从一个目录（0.6.0 起：请求体 / 查询参数给的**工作区目录路径**，或会话头解析出的 `cwd`）**向上找第一个含 `.git` 的目录**；一路到文件系统根都没有就退回那个目录本身（普通文件夹也能用，不要求 `git init`）。目录非法时没有项目根，只剩全局根。
- 两个根都标记 `writable: true`；根不存在时 `exists: false`，目录随写入创建。
- `.agents`（`$DSH_AGENTS_HOME` / `~/.agents`）**不是**本插件的技能根：不扫描、不加载。
- 两个根的**显示名**（0.6.0 起）由客户端的 zh/en 词典给：`roots.user-dsh` / `roots.project-dsh`；词典里没有这个 key 时才退回宿主 label（`roots.js` 返回的「全局 DSH」/「项目 DSH」），两者都没有才显示 `diagnostic.unknown`。宿主那两个 label 是硬编码中文，原来优先用它们会让英文界面掉回中文。
- 本层只做三件事：解析根 → 按 DSH 的发现规则扫描 → 用**重命名 / 复制 / 删除**改变磁盘。写盘一律用 `node:fs`（宿主插件跑在宿主进程里，不走会话的 `workspace-write` 沙箱）。

## 2. 发现规则（对齐 DSH provider）

只扫一层，只认这两个位置：

- 深度 1：`<root>/<name>.md`（扁平），或其 `.disabled` 变体 `<name>.md.disabled`
- 深度 2：`<root>/<name>/SKILL.md`（目录包），或其 `.disabled` 变体

其余规则：

- 文件名**大小写敏感**；嵌套的 `**/SKILL.md` 永远不会被发现；以 `.` 开头的条目一律跳过（`.system` / `.trash` / `.DS_Store` …）。
- `.disabled` 后缀仍被扫描，只标记为「已停用」——这正是关技能的实现方式（文件还在，DSH 的 provider 看不见它）。
- 软链接按 `stat` 语义跟随（指向目录的软链当目录包处理），但**不允许启停/复制/移动**。
- `classifyDiscoveryPath` 只承认上面两种位置：根外路径、深度 > 2、深度 2 的非 `SKILL.md` 都返回 `null`；于是「写」的作用面被限制在扫描器真正会读的文件上（传 `../../../etc/passwd` 只会被拒，不会变成一次 rename）。

## 3. 三个写盘入口

写盘只有 `roots.js` 里这三个函数；路由层不自己调 `rmSync` / `cpSync`。

### 3.1 `toggleSkill(roots, filePath, enabled)` —— 启停（只重命名发现文件）

- 围栏顺序：根内 + 可发现位置 → `error.path.outsideRoots`(400)；文件存在 → `error.toggle.notFound`(404)；目录包软链或发现文件软链 → `error.toggle.symlink`(400)；目标名已存在 → `error.toggle.conflict`(409)，**绝不覆盖**。
- 已经是目标态时直接返回 `{changed: false}`，不落盘。
- 落盘就是一次 `renameSync(target, next)`：`SKILL.md` ↔ `SKILL.md.disabled`、`<name>.md` ↔ `<name>.md.disabled`。**内容一个字不改，文件一个不删**（目录包停用后目录还在）。

### 3.2 `copySkillIntoRoot(targetRoot, sourceSkill)` —— 复制（只往目标根写）

- 源必须**可启停**（`toggleable !== true` → `error.transfer.symlink`(400)，否则会顺着链接写进别人的仓库）；源不存在或没名字 → `error.skill.notFound`(404)。
- 目标已存在同名 → `error.copy.exists`(409)。这是**显式预检**：`cpSync` 的 `errorOnExist` 对「目标已存在且是目录」实测不生效（会静默合并），不能靠它。
- 落地一律走「目标根内写临时产物（目录包 `.tmp-<uuid>/`、扁平 `.tmp-<uuid>.md`）→ `rename` 到位」：中途失败时清理临时产物，目标根里不会留下半份技能（`.` 开头也不会被扫描器认成技能）。
- 源是 `.disabled` 时，复制出来是**启用态**（去掉后缀）。
- 返回 `{name, path, sourcePath, kind, enabled: true, copied: true}`；**只往目标写，绝不碰来源**。

### 3.3 `planRemoval(roots, filePath)` + `removeSkill(removal)` —— 删除（唯一的删除入口）

`planRemoval` 是**纯函数**（只读盘、不写盘），先算清要动哪些路径，按三种形态分开：

| 形态 | 判据 | `targets` | 备份对象（`backupKind`） |
| --- | --- | --- | --- |
| `symlink` | 目录包是软链，或发现文件是软链 | `[链接路径]` | `symlink`（只存链接本身，`readlinkSync` 出的目标记进 `meta.json` 的 `link`） |
| `directory` | `SKILL.md` 所在的包目录 | `[包目录]`（含脚本、resources） | `directory`（整包） |
| `flat` | 单个 `<name>.md` | `[那个文件]` | `flat`（单文件） |

- 围栏：根外 → `error.path.outsideRoots`(400)；不存在 → `error.skill.notFound`(404)。
- `removeSkill` 按 `form` 动盘：`symlink` → 只 `unlinkSync` 链接本身（**绝不 dereference**）、`directory` → `rmSync(item, {recursive:true})`、`flat` → `unlinkSync(item)`；返回 `{removed, changed: true}`。
- **备份在调用方（路由层）之前完成**：`removeSkill` 只负责删。
- **技能根本身永远不会被删**：`targets` 只可能来自扫描到的发现文件，根目录不在任何一条 `targets` 里。

## 4. 备份与恢复的衔接（`backups.js`）

- 删除 / 移动前调 `repositories.backupSkill({name, target, kind})` → `backups.create`，布局 `<DSH_HOME>/skill-console/backups/<技能名>/<时间戳>/{content/,meta.json}`；时间戳撞名时自增，保证目录全新。
- 备份抛错 → 路由层转 500 `error.delete.backup`，**一个字节都不删/不移**。
- 恢复走 `GET /backups` + `POST /restore`：`backups.put` 把 `content` 原子放回 `meta.json` 记的 `target`；恢复前会把当前版本再备份一次。

## 5. 写操作的错误码（本层 + 路由层编排）

| code | 状态 | 触发点 |
| --- | --- | --- |
| `error.path.outsideRoots` | 400 | `toggleSkill` / `planRemoval`：路径不在已知根内或不在可发现位置 |
| `error.toggle.notFound` | 404 | `toggleSkill`：发现文件不存在 |
| `error.toggle.symlink` | 400 | `toggleSkill`：软链接不允许启停 |
| `error.toggle.conflict` | 409 | `toggleSkill`：目标名已存在，拒绝覆盖 |
| `error.skill.notFound` | 404 | `copySkillIntoRoot` / `planRemoval`：源不存在或没名字 |
| `error.transfer.symlink` | 400 | `copySkillIntoRoot`；`/skills/move-to-library` 的软链来源 |
| `error.copy.exists` | 409 | `copySkillIntoRoot`：目标位置已有同名 |
| `error.transfer.exists` | 409 | `/skills/move-to-library`：**可用仓库**里已有同名（**按技能名判**，不按目标路径） |
| `error.workspace.invalid` | 400 | 写/读接口里**显式给的** `project` 解析不出（相对路径 / 不存在 / 不是目录）：写路径**绝不回落到请求头会话** |
| `error.role.noProject` | 400 | 写接口**没给** `project`，且会话头也解析不出项目根；`/skills/move-to-library`（来源是项目技能时）、`target:'project'` 的安装同样落到这条 |
| `error.delete.backup` | 500 | 删除 / 移动前的备份失败：**什么都没改** |

## 6. 「移到可用仓库」的顺序（`routes.js` 编排）

① 备份原处那份（失败 → 500，什么都不移）→ ② `copySkillIntoRoot(libraryRootOf(), source)` 复制进可用仓库 → ③ `removeSkill` 删原处那份。

③ 失败**不回滚**：库里那份已经就位，响应 `sourceRemoved:false` + `warning` 如实报告，用户再点一次「删除」即可清掉原处那份。复制失败时按复制自身的错误码上抛，原处没动。

来源可以是**任意技能根**（全局或当前工作区项目技能根）：0.7.0 之前这条只允许全局 → 项目，0.8.0 起统一成「搬进可用仓库」，`error.transfer.notGlobal` 这枚码**已不再产生**。可用仓库不是技能根（不在 `ROOT_DEFS` / `resolveRoots` 里），所以 `libraryRootOf()` 是路由层临时合成的根描述，只用来复用 `scanRoot` / `copySkillIntoRoot`。
