# 下游复用与持久化评估

本轮在 2026-10-24 对照本地源码与远端 HEAD。下列提交均与查询时的远端 HEAD 一致；源码中存在功能，不表示已经验证其真实账号、生产部署或全部平台表现

## 当前结论

保留 aocuan/toSub2 的 UI、Node 授权流程和 CPR 专用连接器，按模块吸收下游修复。建议增加 SQLite 数据层，不整体切换到另一个重写项目

数据库迁移尚未实施。当前已移植并验证凭据子进程并发限制，以及运行期间的删除与启动/恢复互斥检查；其他条目仍是评估或待实现项

## 参考项目与适用范围

| 项目与核对提交 | 已检查的实现 | 复用判断 |
| --- | --- | --- |
| [spongehah/toSub2](https://github.com/spongehah/toSub2/tree/9faff751f2a0fe94b4a4a5744683dd5b8672daf4) | 凭据子进程限流、删除标记与恢复检查、代理出口检查、搜索与分页 | 与当前结构最接近，优先移植独立修复；并发修复已纳入 |
| [doublelzz/toSub2](https://github.com/doublelzz/toSub2/tree/958007bb8bbfee617b1f24564692c649538b27f4) | `task-query.mjs`、`account-insights.mjs`、`mfa-workspace.mjs`、Hero SMS、SMS 价格选择与失败轮换 | 搜索/状态/日期筛选及日志值得复用；其工作台换肤不纳入。套餐信息必须核对真实接口；CPR 用量不在本地另建口径 |
| [DomenLee/toSub2](https://github.com/DomenLee/toSub2/tree/dd66b41a2a5d58ba3fc7b25eeeff4acc50726111) | `deploy/server/security.mjs`、身份绑定、同步队列、401 修复限流与部署测试 | Linux 凭据加密、同步与登录分离、修复次数持久化值得适配；Sub2API 回写、累计扣费与级联删除不能直接换 URL 使用 |
| [zhoudashuaibi/tosub2V3](https://github.com/zhoudashuaibi/tosub2V3/tree/fa639ca20d3d0fbf442e6f462407cfde9f171671) | `server/lib/db.js`、`crypto.js`、SQL 迁移、任务引擎、备份脚本 | SQLite/WAL、账号与任务分离、事件记录、服务端分页是主要参考；当前版已移除本地登录并改用 redeem401 远端服务，不能直接作为我们的授权底座 |
| [Cengyj/toSub2-go-port](https://github.com/Cengyj/toSub2-go-port/tree/ae6806ea80da525ae8e40f10a10f5c6b07427fa9) | `internal/store/store.go`、凭据与恢复模块、单二进制构建 | 可借鉴原子文件、文件同步与恢复边界；仍有 JSON 文件存储，不是现成 SQLite 方案。整体采用需要重写 Node 运行路径 |
| [1080ssf/codex-navo](https://github.com/1080ssf/codex-navo/tree/e3a301d29cae4b24ca3a635c0c3c2a546e7436b4) | Electron 配置、桌面账号隔离与 API 池设计、README 当前维护说明 | Windows 桌面产品方向不同；账号池、网关、用量调度已属于 CPR 范围，不搬入 CPR Auth |

## 当前存储事实

- `src/console-server.mjs` 通过内存 `jobs` Map 调度任务
- 任务信息写入各目录的 `job-meta.json`，启动和请求时扫描授权输出、检查点和元数据恢复
- 协议输出和检查点是文件，运行日志主要留在内存，重启恢复日志不能替代原始操作历史
- `src/cpr-connector.mjs` 将连接配置与全部同步记录写到一个 AES-GCM 加密状态文件，另有密钥文件
- 密码、2FA 和登录代理通过 macOS Keychain / Windows DPAPI 保存；Linux 的原凭据存储仍不支持持久保存
- 原有接码和邮件等前端设置仍存在浏览器存储路径，不能把 CPR 配置已移到服务端等同于全部配置已统一

所以当前是有文件持久化、没有数据库。单份文件原子替换不能保证任务、同步记录、删除意图和外部 CPR 调用作为一个事务提交

## 已验证修复与待复现问题

| 项目 | 证据与状态 | 下一步 |
| --- | --- | --- |
| 批量凭据子进程无并发限制 | 新增 32 条并发保存测试，修复前峰值 32、断言失败；移植后峰值不超过 8，单次异常后其余任务完成 | 已修复；继续保留原平台凭据实现 |
| 删除任务与异步启动交错 | 延迟邮箱响应的服务用例已复现并通过修复；删除使 `queueRunId` 失效，准备完成与启动前均检查删除状态 | 已修复 |
| 删除任务与目录扫描交错 | 迟到产物用例已复现并通过修复；运行期间保留删除标记，恢复前二次检查 | 当前进程保护已修复；数据库方案仍需持久删除状态和文件清理队列，不能宣称跨重启保护已完成 |
| Linux 重启恢复缺凭据 | 当前 `createCredentialStore({platform: 'linux'})` 保存返回 501，已有测试确认 | 借鉴 DomenLee 加密存储，适配为统一数据层，保留现有系统凭据读取迁移路径 |
| 历史日志与同步状态分散 | 当前 Map、元数据、输出和加密同步文件分别维护 | SQLite 作为状态唯一来源，协议产物继续作为文件 |

这些是源码审查与隔离测试结果，不代表已经定位用户遇到的全部 BUG；真实登录失败需对应操作、日志脱敏后的错误和目标平台进一步复现

## 数据库实施建议

第一版使用 SQLite + better-sqlite3，单服务实例运行，不增加独立数据库服务。固定受支持的 Node 版本并验证原生模块的 macOS、Linux、Windows 安装。采用 WAL、外键、事务和 busy timeout

| 表 | 职责 |
| --- | --- |
| `accounts` | 本地账号资料和稳定 ID，明确邮箱与工作区身份边界 |
| `jobs` | 授权尝试、状态、阶段、队列与恢复信息；子进程句柄仍只在内存 |
| `job_events` | 脱敏的操作时间线、失败原因和恢复记录，设置保留策略 |
| `cpr_connections` | CPR 目标、分组、代理、自动同步选项；管理员 Key 单独加密 |
| `cpr_sync_attempts` | 提交 ID、凭据指纹、远端任务 ID、目标地址快照、状态与结果 |
| `account_credentials` | 加密密码、2FA、邮件接入材料；密钥放数据库外 |

不把整个内存 job 对象序列化后丢进一列就算迁移。持久业务字段与 child、timer、controller、Promise 等运行资源分离；保留现有 API 响应和 UI 结构

关键约束：

1. 授权成功与创建同步意图在一个本地事务完成；HTTP 请求在事务外执行
2. 同一目标、账号和凭据版本只允许一个活动同步尝试；提交超时保留 unknown，不自动重发
3. 重启后按远端任务 ID 查询；CPR 不可查询时进入人工核对，数据库不能消除跨服务结果未知
4. 删除先持久化删除意图，停止运行任务，完成文件清理后结束；恢复扫描不能复活已删除账号
5. 凭据采用 AEAD 并绑定账号 ID 与字段用途；已有密钥损坏时启动失败，不生成新密钥覆盖
6. 日志和状态查询默认不返回密钥、密码、token；数据库文件本身不等于已加密

### 迁移与验收

- 在隔离副本验证旧 JSON、输出与 `cpr-state.enc` 导入，保留任务 ID、目标、远端任务 ID 和未知状态
- 先备份再停写迁移，完成后仅数据库负责状态写入，旧文件作为恢复备份，不长期双写
- 校验数量、映射、指纹、缺失凭据与恢复状态；重复执行迁移不会重复建立任务或触发授权
- 重启验收覆盖 queued、等待输入、运行中断、已提交 CPR、unknown、已删除和只剩旧产物等状态
- 数据库在线备份使用 SQLite backup API；产物和密钥需协调备份，不能只复制正在写入的主库文件

下游也有需要修正的边界：V3 当前 `crypto.js` 对长度错误的已有密钥会继续生成覆盖；`cleanupFinishedJobs` 在数据库事务中删除文件，文件删除无法随 SQL 回滚。因此只参考并适配这些模块，不直接整文件复制

## 推荐实施顺序

1. 保留删除/恢复竞态回归和原版 UI；跨重启删除保护随持久化改造补齐
2. 增加 SQLite 与 Linux 凭据持久化，完成旧数据迁移和重启验收
3. 吸收任务搜索、日期/状态筛选、日志持久化和批量结果汇总，嵌入原有表格与弹窗
4. 对接 CPR 实际账号状态后，再实现默认关闭的受限自动修复；不要照搬 Sub2API 的错误分类、强制覆盖与删除逻辑
5. 在真实测试账号、目标 CPR 与目标部署环境验收后发布

参考库文档：[better-sqlite3 API](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md)。本轮已核对事务和在线备份语义；具体依赖版本与运行平台矩阵在实施时固定
