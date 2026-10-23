# 第三方代码来源

本项目保留 poxiao33/toSub2 的历史与 [MIT 许可](LICENSE)，开发基线来自 aocuan/toSub2

## spongehah/toSub2

- 来源：https://github.com/spongehah/toSub2/tree/9faff751f2a0fe94b4a4a5744683dd5b8672daf4
- 复用文件：`src/credential-store.mjs`
- 复用内容：凭据子进程并发限制、进程创建异常与 stdin 错误处理
- 适配内容：`src/console-server.mjs` 的任务删除标记、异步启动与恢复前检查
- CPR Auth 对凭据文件目录、Keychain 服务名和 DPAPI 用途标识做了独立命名，避免与 toSub2 共用或删除彼此的凭据
- 许可：MIT，原版权声明为 `Copyright (c) 2026 poxiao33`，完整声明保留在本仓库 LICENSE
- 本项目另加批量并发、失败后队列继续处理、延迟邮箱响应和迟到产物的回归验证
