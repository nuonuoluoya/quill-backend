# Quill 后端

独立 NestJS API，项目目录为 `D:\quill-backend`，原生微信小程序位于 `D:\Quill`。后端已从 `D:\agent\pidanvocal\_mini\backend` 迁出，运行、构建和测试不再依赖原工作区。

## 本地启动

需要 Node.js 22.12+。本次迁移保留了依赖、数据库、音频及开发签名密钥，直接启动即可：

```powershell
Set-Location D:\quill-backend
npm.cmd run dev
```

全新安装先执行 `npm.cmd ci`；需要原创演示书籍时，在 API 启动前执行 `npm.cmd run cli -- seed`。现有迁移数据无需重新导入。

API 地址为 `http://127.0.0.1:3210/v1`，接口文档为 `http://127.0.0.1:3210/docs`。前端已有本机接口配置无需修改。微信开发者工具中导入 `D:\Quill`；真机调试需改用手机能够访问的主机地址，并同步后端 `HOST`、`PUBLIC_BASE_URL` 与前端 API 配置。

## 配置与数据

可将 `.env.example` 复制为 `.env` 后填写配置。`.env` 固定从本项目根目录读取；`DEV_DB_PATH`、`MEDIA_ROOT` 的相对路径也以项目根目录为基准，支持绝对路径。

- 默认数据库：`.data/postgres`（PGlite，无需额外数据库服务）。
- 默认音频目录：`.data/media`。
- 开发签名密钥：`.data/development-signing-key`，迁移时必须与数据一起保留。
- 微信登录：在后端 `.env` 设置 `WECHAT_APP_ID` 和 `WECHAT_APP_SECRET`，AppID 与小程序一致。游客样本无需微信密钥。
- 生产环境必须设置 PostgreSQL `DATABASE_URL`、微信凭据、至少 32 字符的 `MEDIA_SIGNING_SECRET` 和 HTTPS `PUBLIC_BASE_URL`。

同一个 PGlite 数据目录只能由一个进程打开；运行内容运维 CLI 前先停止 API。正式 PostgreSQL 支持并发连接。`.env`、`.data`、依赖和构建产物已在 `.gitignore` 中排除，实际 AppID、密钥、数据库与私人内容不提交到 Git。

## 微信登录返回 503

先查看 `POST /v1/auth/wechat` 的响应正文。若提示“微信登录尚未配置，请先体验样本”，说明启动时缺少 `WECHAT_APP_ID` 或 `WECHAT_APP_SECRET`，需要补充后端配置。

1. 仅在 `.env` 不存在时从 `.env.example` 复制，保留已有配置。
2. 在后端 `.env` 填写与前端微信项目一致的 `WECHAT_APP_ID`，以及该小程序对应的 `WECHAT_APP_SECRET`。AppSecret 仅在本机后端配置或环境中填写，不发到聊天、不放到前端、不提交 Git。
3. 保存后停止并重新启动后端，再在小程序点击登录以获取新的 `wx.login` code；不要依赖 `.env` 变更自动热加载。

若正文为“微信登录服务暂不可用”，应检查后端访问微信服务的网络和超时情况。HTTP 503 本身无法区分配置缺失与网络故障，也不能据此判断为开发者工具或基础库版本问题。凭据未配置时公开样本仍可使用，不提供模拟登录绕过身份校验。

## 构建与校验

```powershell
npm.cmd run check
npm.cmd test
npm.cmd run schema:check
npm.cmd run contract:check
npm.cmd run build
npm.cmd start
```

编译入口为 `dist/src/main.js`。本地 API 运行后，可在 `D:\Quill` 执行 `node scripts/smoke-api.cjs` 验证前后端接口。

## 目录

| 目录 | 用途 |
| --- | --- |
| `src` | 接口、登录、授权、进度同步、媒体与内容管理 |
| `migrations` | 数据库表和索引 |
| `contracts` | 类型、OpenAPI、输入 Schema 和原创样本 |
| `schemas` | 输入 v2 Schema 的基准文件；修改后执行 `schema:update` 同步契约快照 |
| `tests` / `scripts` | 集成测试与契约检查 |
| `deploy` | 本地 PostgreSQL 与 API 容器示例 |
| `.data` | 本地持久化数据，不纳入版本管理 |

`contracts` 与 `schemas` 已随后端独立维护；原工作区中的副本属于历史交付资料。接口变化时运行 `npm.cmd run openapi` 更新本项目契约。

## 生产部署

生产使用独立 PostgreSQL，API 基址为 `https://codingluke.site/v1`，`PUBLIC_BASE_URL=https://codingluke.site`。服务器环境配置与本地开发 `.env` 分开；本地 API 可以继续使用回环地址。

- `deploy/compose.production.yaml` 使用固定外部卷 `quill_pgdata`，音频独立挂载 `/var/lib/quill/media`，API 只映射 `127.0.0.1:3210`，数据库不映射公网端口。Node/PostgreSQL 官方镜像按摘要锁定。
- API 从 `/etc/quill/backend.env` 读取生产环境变量；Compose 通过 `env_file` 注入，密钥不进入镜像或 Git。设置 `TRUSTED_PROXY=172.30.42.1/32`，只信任此部署网络的宿主机代理，Nginx 覆盖转发 IP。
- 生产启动和普通内容 CLI 不自动建表；使用迁移身份执行 `node dist/src/migrate.js`，再给 API 账号授予所需 DML 与序列权限。
- 停止本地 PGlite 使用者后，可执行 `npm run data:transfer -- export FILE`。使用目标库迁移身份执行 `node dist/src/transfer-cli.js import FILE`，只接受空库；事务内核对字段、外键与逐表摘要。`verify FILE` 可再次核对数据和审计序列。迁移文件含私人数据，只可置于受限目录，不提交。
- 生产 `seed` 和 `dev-session` 禁用，书籍运维继续使用 `validate/import/publish`；导入新音频时给运维容器单独提供可写媒体挂载，常驻 API 使用只读挂载。
- `/v1/health/ready` 使用 `READY_TOKEN`，健康检查验证实际数据库连接。进程正常关闭数据库后退出，容器预留 30 秒停止时间。

部署顺序见 [生产部署流程](deploy/PRODUCTION-PLAN.md)。本次已授权实施和旧应用清理；旧 MySQL 不迁移、不备份、不卸载。新服务验证通过后再删除核实的旧应用目录和对应 PM2 项目。服务器内部部署和数据迁移已验证，公网因备案拦截及证书过期尚未接通；旧应用暂留。详见 [2026-09-20 部署记录](deploy/DEPLOYMENT-2026-09-20.md)。

部署依赖已锁定修复后的 Ajv 8.20.0 和 Multer 2.3.0；生产依赖审计通过。PostgreSQL 并发集成测试使用持续监听的独立测试服务器，避免临时 HTTP 服务启停干扰并发结果。

## 已确认的后续内容扩展

书籍、博客、电影和电视剧统一使用文字与句子音频，不涉及视频能力。电视剧保留“内容 → 季 → 集 → 句子”的目录扩展；分季采用稳定身份，跨季同号剧集不得串音频或进度，旧无分季内容继续兼容。音频访问与存储路径共用现有机制。具体要求见 [规格第 3.4 节](docs/SPEC.md)；本次仅确认规格，后端多类型字段、筛选和分季接口尚未实现。

## 提交约定

GitHub 仓库：[nuonuoluoya/quill-backend](https://github.com/nuonuoluoya/quill-backend)，远端名称为 `origin`。

每次后端修改先更新 `D:\agent\SPEC\Quill\SPEC.md` 中的相关行为、接口、约束或验收标准，再修改代码。实现后将规格同步至本仓库的 `docs/SPEC.md`，运行相关检查，再将规格、实现及相关文档一并提交并推送。`docs/SPEC.md` 是规格快照，不独立维护；缺陷修复也先明确预期行为和回归验收要求。

特性、配置、启动方式或接口发生变化时，在同一次提交中更新本 README，并运行相关检查。只提交示例配置，不提交实际凭据或运行数据。

## 本次迁移记录（2026-09-17）

代码、依赖、契约、Schema、原数据库、52 个音频文件及开发签名密钥已迁入本目录。原 `_mini/backend` 已移除，原工作区的后端启动脚本和前端 README 已更新。

迁移后首次启动发现原 PGlite 数据库的 WAL 检查点无效。已先完整备份，再在独立副本中选择通过 CRC 校验的旧检查点，让 PostgreSQL 重放后续 WAL，随后正常关闭并重新打开验证；未重新初始化数据库或重新 seed。恢复库包含 2 本书、6 章、48 句、52 条音频和 4 条内容审计记录，用户、会话和云端进度表为空。故障库及恢复前备份分别保留在 `.data/postgres-interrupted-20260917` 和 `.data/postgres-before-recovery-20260917`，不要提交到 Git。恢复操作记录保存在 `.data/migration-20260917`。

已通过类型检查、编译、20 项集成测试、Schema/OpenAPI 检查、小程序 API 联调及停止后重启验证。全部 48 句正文与样本一致，52 个签名音频下载哈希与原样本匹配，HEAD 和 Range 请求通过。服务启动失败时会关闭数据库，重复退出信号共用同一次关闭操作。Docker 配置已改为独立项目构建上下文，尚未进行容器启动验收。