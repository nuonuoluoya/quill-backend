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

2026-09-30 已将 `93f282a` 部署到生产并切换 Nginx，公网 HTTPS API 与签名媒体验收通过；数据库卷和媒体目录继续复用，旧应用已按授权清理，MySQL 保留。随后已完成小程序合法域名、生产地址、真实微信登录及开发者工具播放联调；iPhone 真机听感验收仍需完成。内容与授权不随代码自动同步；随后已单独完成 Harry Potter 七部私人内容上线，见下方内容运维记录。详见 [最新部署记录](deploy/DEPLOYMENT-2026-09-30.md)、[生产部署流程](deploy/PRODUCTION-PLAN.md)；首次迁移证据保留在 [2026-09-20 记录](deploy/DEPLOYMENT-2026-09-20.md)。

部署依赖锁定 Ajv 8.20.0、Multer 2.4.0 及 Swagger 使用的 js-yaml 5.4.1。2026-09-30 发布前修补新增的 Multer/js-yaml 拒绝服务公告，保持 NestJS/Swagger 主版本不变；生产依赖审计与契约回归是发布前置检查。PostgreSQL 并发集成测试使用持续监听的独立测试服务器，避免临时 HTTP 服务启停干扰并发结果。

## 多类型内容与电视剧分季

已支持 `GET /v1/books?contentType=book|blog|movie|tv` 按来源分类查询，省略类型返回全部。后端先按类型与权限筛选再分页；切换类型必须清空 cursor，跨类型复用游标返回 400。现有路由、bookId 和音频签名接口保持兼容。

电视剧同时支持平铺剧集和“季 → 集”目录。详情返回 seasons，剧集带 episodeNumber；分季剧集另带 seasonId。同季集号不能重复，不同季可各自从第 1 集开始，内部仍使用唯一集/句子 ID。四类内容统一使用文字和音频，不涉及视频。

导入包可新增 contentType、可选 HTTPS coverUrl 和电视剧季信息；旧包默认书籍，存量数据在读取时补充展示字段，不重建数据库或移动音频。字段、示例与前端接入方式见 [多类型内容接口及导入说明](docs/CONTENT-TYPES.md)。

本次已通过类型、Schema、OpenAPI、构建检查，本地及服务器隔离环境各 32 项测试通过；服务器的 29 项 HTTP/业务集成测试使用真实 PostgreSQL。2026-09-30 已随 `93f282a` 上线多类型后端，并验证公网分类查询及跨类型游标拒绝；后续已单独导入 Peppa Pig 电视剧，见下方内容运维记录；前端类型标签及季目录交互由前端任务维护。电影和博客尚无真实素材。

## 提交约定

后端开发由后端会话负责；需要前端参与的实现、配置、交互或验收，交由现有前端会话处理，并提供接口契约、影响范围、依赖及验收要求。

GitHub 仓库：[nuonuoluoya/quill-backend](https://github.com/nuonuoluoya/quill-backend)，远端名称为 `origin`。

每次后端修改先更新 `D:\Quill-relative\SPEC.md` 中的相关行为、接口、约束或验收标准，再修改代码。实现后将规格同步至本仓库的 `docs/SPEC.md`，运行相关检查，再将规格、实现及相关文档一并提交并推送。`docs/SPEC.md` 是规格快照，不独立维护；缺陷修复也先明确预期行为和回归验收要求。

特性、配置、启动方式或接口发生变化时，在同一次提交中更新本 README，并运行相关检查。只提交示例配置，不提交实际凭据或运行数据。

## 本次迁移记录（2026-09-17）

代码、依赖、契约、Schema、原数据库、52 个音频文件及开发签名密钥已迁入本目录。原 `_mini/backend` 已移除，原工作区的后端启动脚本和前端 README 已更新。

迁移后首次启动发现原 PGlite 数据库的 WAL 检查点无效。已先完整备份，再在独立副本中选择通过 CRC 校验的旧检查点，让 PostgreSQL 重放后续 WAL，随后正常关闭并重新打开验证；未重新初始化数据库或重新 seed。恢复库包含 2 本书、6 章、48 句、52 条音频和 4 条内容审计记录，用户、会话和云端进度表为空。故障库及恢复前备份分别保留在 `.data/postgres-interrupted-20260917` 和 `.data/postgres-before-recovery-20260917`，不要提交到 Git。恢复操作记录保存在 `.data/migration-20260917`。

已通过类型检查、编译、20 项集成测试、Schema/OpenAPI 检查、小程序 API 联调及停止后重启验证。全部 48 句正文与样本一致，52 个签名音频下载哈希与原样本匹配，HEAD 和 Range 请求通过。服务启动失败时会关闭数据库，重复退出信号共用同一次关闭操作。Docker 配置已改为独立项目构建上下文，尚未进行容器启动验收。

## 同一 Wi-Fi 真机调试

手机上的 `127.0.0.1` 指向手机自身。临时局域网调试时，先用 `ipconfig` 查看电脑当前联网网卡的 IPv4，再同步修改以下本地配置（`<电脑局域网IPv4>` 必须替换为真实地址）：

- 前端 `config/config.js`：`apiBaseUrl: 'http://<电脑局域网IPv4>:3210/v1'`。
- 后端 `D:\quill-backend\.env`：`HOST=<电脑局域网IPv4>`、`PUBLIC_BASE_URL=http://<电脑局域网IPv4>:3210`。媒体地址不带 `/v1`；只改前端会导致后端仍只接收本机请求，或音频继续返回手机不可访问的地址。
- 在运行后端的终端按 `Ctrl+C`，等待退出后执行 `npm.cmd run dev`；同一 PGlite 数据目录不能被两个后端进程同时打开。
- 手机和电脑连接同一可互访 Wi-Fi；先在手机浏览器访问 `http://<电脑局域网IPv4>:3210/v1/health/live`，确认可达，再在开发者工具重新编译、重新发起真机调试。若浏览器不通，检查后端监听、路由器客户端隔离和防火墙；仅按需放行可信局域网的 TCP 3210，不关闭防火墙。
- 临时开发调试按[微信官方网络说明](https://developers.weixin.qq.com/miniprogram/dev/framework/ability/network.html)设置“开发环境不校验请求域名、TLS 版本及 HTTPS 证书”，手机也需处于调试模式。正式验收和上线使用合法 HTTPS 域名，并恢复域名及证书校验。
- 电脑 IP 改变后同步更新三个地址；还应验证播放接口返回的媒体主机及实际音频访问。电脑自测不能证明手机已连通。开发者工具的本地登录缓存不等于手机已有登录状态，私有书籍仍需当前账号授权。

实际本地地址、登录凭据和 `.env` 不提交 Git。纯模拟器调试可将上述三个地址一起恢复为 `127.0.0.1`。

## 本地手机账号与私有书架

手机通过“我的与设置”完成微信登录后，使用该手机会话的 `user.id` 作为书籍授权目标。开发者工具中手工写入的 `dev-session` 属于独立测试账号，不会自动把权限转移到微信账号。只需提供用户 ID，无需复制 accessToken；真实账号 ID、会话、数据库和媒体只留在本地。

本地 PGlite 运维前正常停止 API，待旧进程退出后再运行导入/发布/授权，完成后恢复 `npm.cmd run dev`。已有同一构建由导入器校验后复用；相同 buildId 对应不同内容时拒绝覆盖。首次发布使用 `none`，后续发布必须传入核实的当前活动 buildId；已发布的同一构建无需重复发布。

```powershell
npm.cmd run cli -- import "<书籍包目录>" private
npm.cmd run cli -- publish <bookId> <buildId> <已核实的当前活动buildId或none>
npm.cmd run cli -- grant "<手机微信账号user.id>" <bookId>
```

只有导入、发布与有效账号授权同时成立，书籍才会出现在“我的内容 → 书籍”。完成后在手机下拉刷新即可，不需要把书名写入前端。若授权带有未来开始时间或已过期，应由运维核对并调整授权期限；不能仅以存在授权记录判断可访问。

此前本地调试阶段按用户要求只发布并授权 Harry Potter 第 1、2 部，使用 `hp1-en` 和 `hp2-en`，合计 35 章。第一部源包现位于 `D:\agent\pidanvocal\books\hp1-en`（原 `current` 目录），第二部位于 `D:\agent\pidanvocal\books\hp2-en`。其余书籍在该本地调试阶段不发布、不授权；后续生产七部上线见下文独立记录。各包按原审核状态导入，待复核句不提升为可播放；整章音频是否可用由包中的实际元数据决定。接入后逐本验证账号书架、全部章节计数、正文和音频读取，公开样本入口保持原范围。

范围缩小时已产生的第 3、4 部导入数据保留在本地待发布状态；第 3 部的额外发布已撤回，第 4 部未发布，均未给本次手机账号新增授权。该本地调试账号当时可见第 1、2 部共 35 章、13,146 句正文和 12,784 条可播放逐句音频；已核对全部章节计数和正文，并逐本抽验签名音频的 HTTP Range 读取。两部均未提供整章音频扩展。

## 生产私人内容（2026-09-30）

按用户后续授权，已将 Harry Potter 第 1～7 部上传生产，全部设为 private，仅授权给真实微信登录确认的本人线上账号。共 199 章、79,868 句、77,618 条可播放音频；其余句子保留原审核状态。公开样本范围不变，生产账号刷新“我的内容”即可获取。

导入、媒体完整性、权限及抽样公网播放验证结果见 [七部私人内容上线记录](deploy/CONTENT-IMPORT-2026-09-30.md)。这是独立的内容导入操作，不是上传本地数据库或把私人音频纳入 Git，也不代表已完成 iPhone 真机听感验收。

## Peppa Pig 私人电视剧（2026-09-30）

已从用户提供的十二个季包合并上线 `peppa-pig-en`，类型 `tv`，十二季共 462 集、41,528 句，其中 34,602 句可播放，6,926 句保留待复核状态。仅授权本人线上账号；原有七部私人书籍与两个公开样本不变。源 partial 范围按现有契约映射为 sample，表示节选，不表示公开。

生产账号刷新“我的内容 → 电视剧”即可获取。后端保留十二季结构，使用支持 seasons 的前端版本可按季选集；前端实现及交互验收见对应前端任务记录。适配、发布及后端验收结果见 [Peppa Pig 上线记录](deploy/PEPPA-IMPORT-2026-09-30.md)。


## 播客与 English Pod

新增独立 `podcast` 类型，按“播客 → English Pod → 期数 → 对话 / 教学”组织。前端播客替换原博客标签，保留五项分类；`blog` 仅保留历史数据/API 兼容。`GET /v1/books?audience=member&contentType=podcast` 按权限筛选并分页。摘要 `episodeCount` 是期数；详情 `episodes` 提供期号与主题，章节 `episodeId/part` 对应对话或教学。播放和进度沿用 chapterId/sentenceId 接口。

使用 `npx.cmd tsx scripts/prepare-englishpod.ts SOURCE NEW_OUTPUT_DIRECTORY` 适配源包，再执行 CLI validate/import/publish/grant。输出目录必须新建且位于源目录之外，原始文件不改动。365 期的 8 处缺源保留缺失状态，待复核句不开放播放，不合成整期音频。详见 [内容类型与播客导入说明](docs/CONTENT-TYPES.md)。前端由前端会话接入，生产部署及内容导入结果以独立上线记录为准。

后端播客实现已通过 34 项回归、类型、Schema/OpenAPI、构建及完整素材校验；[English Pod 上线计划](deploy/ENGLISHPOD-PLAN-2026-09-30.md)列出具体发布范围和步骤。2026-09-30 已经用户明确授权部署 `4fa1e86` 并完成私人内容导入：365 期、722 部分、88,995 句可播放，两位原有目标用户均已开通且无到期时间。前端已使用真实登录态通过生产目录、缺失提示及正文联调；刷新“播客”即可查看 English Pod，手机听感仍需实际验收。详见 [English Pod 上线记录](deploy/ENGLISHPOD-IMPORT-2026-09-30.md)。

## 第一章游客预览与新用户赠书

游客入口使用独立 `hp1-chapter1-preview`（`sample-public` / `sample`），原 `hp1-en` 整本保持私人内容。预览详情 `chapters` 仅含第一章，`previewOfBookId` 指向私人原书，`lockedChapters` 只包含后续章的 `{id,title,number}`，供前端展示锁章并引导自主登录；两项预览字段不进入摘要。锁章没有正文或音频，不能从预览接口读取。预览与整书的版本、媒体身份和进度互相独立。

管理端按已核实的源活动构建准备新包，再校验、导入并发布。以下命令只用于运营方明确授权公开第一章的内容；原书可见性不变，源包/数据库不会因准备操作被改写。输出目录必须不存在，父目录须存在，音频逐个校验后才复制；完整正文和媒体不进入 Git。

```powershell
npm.cmd run cli -- prepare-preview hp1-en <已核实的源buildId> hp1-chapter1-preview <全新输出目录>
npm.cmd run cli -- validate <输出目录>
npm.cmd run cli -- import <输出目录> sample-public
npm.cmd run cli -- publish hp1-chapter1-preview <准备命令输出的buildId> none
```

生产运行时设置 `NEW_USER_BOOK_ID=hp1-en` 后，真实微信首次建号自动授予完整第一部，立即生效且无到期时间；随后前端使用 `audience=member` 访问。默认空值关闭赠书，修改需重启 API。既有账号登录不补授，撤销或到期权限不恢复，本地开发会话不赠书，其他内容权限不变。目标不存在、非私人或未有效发布时，首次登录返回 `503 SERVICE_UNAVAILABLE`，账号/权限/会话事务整体回滚；管理员恢复目标或关闭配置后可重试。并发首次登录仅产生一次 `new-user-grant` 审计，不调用公开管理接口。

游客仍可主动阅读和播放第一章，无需登录；待复核句继续不可播放。公开预览的全文音频能力以源第一章实际素材为准，不生成缺失音频。部署与实测结果记录在后续生产验收中；自动化通过不等于微信审核通过或真机听感验收完成。

2026-10-01 已部署 52e93ce、发布第一章预览并启用新账号 hp1-en 授权。真实匿名正文/音频和全部锁章拒绝访问已核验；前端真实游客目录、锁章登录入口及主动单句播放联调通过，全程无微信登录、账号凭证或云进度请求。详细结果见 [HP1 预览上线记录](deploy/HP1-PREVIEW-2026-10-01.md)。

## 2026-10-04 联合审查修复

登录路径的大小写和单个尾斜杠变体共用同一限流预算，只有精确健康路由的 GET/HEAD 请求豁免；内容路径中出现 health 不再跳过限流。各类请求阈值保持不变，超限按 429 与 Retry-After 处理。

同一内容构建重导时，包摘要与可见性都必须匹配。把已公开内容按 private 重导（或反向）会明确拒绝，不会隐式更改可见性，也不会以 reused 成功掩盖范围冲突；既有发布、授权和审计不受影响。

`npm run contract:check` 兼容 Windows CRLF 与 LF 快照，仍拒绝字段/类型变化、非换行空白和其他真实漂移。生成契约继续使用 LF。本轮验证在隔离原创夹具和测试库进行，代码提交不代表已部署生产。

测试工具固定为 `vitest@4.1.11`，使用 `vitest run` 的 Node/forks 模式，不启动 UI、浏览器或 API 监听服务。新版配置移除不再支持的 `minWorkers`，仍通过 `maxWorkers: 1` 与 `fileParallelism: false` 串行运行测试。开发环境继续要求 Node >=22.12；本轮已在 Node 24.11.0 与最低支持版本 22.12.0 上通过全部 44 项测试，并在 22.12.0 上通过类型、测试配置类型、Schema/OpenAPI 与构建检查。

2026-10-04 更新锁文件后的完整 `npm audit --json` 和 `npm audit --omit=dev --json` 均为 0 项漏洞；生产依赖的版本与完整性记录未变。此次升级仅涉及开发测试工具，不代表已部署生产。

2026-10-04 经用户后续授权，以上修复已随代码 3d7e701 部署生产；API/数据库健康，本机及独立公网预览、私有权限边界、媒体读取验收通过，原有内容、授权和进度保留。回滚点为 52e93ce，详见 [本轮部署记录](deploy/DEPLOYMENT-2026-10-04.md)。

## Bluey 私人电视剧

2026-10-04 已上线用户提供的 Bluey 三季，归入“电视剧”，按一个 Bluey 条目展示第一季52集、第二季52集、第三季37集，共141集。与 English Pod 相同的两个现有目标用户已获无到期授权；刷新“我的内容 → 电视剧”即可读取，不给新用户自动开通。

共23,979句，13,775句可播放，10,204句保留待复核文字并禁用音频。原审核状态不提升，第三季按现有37集呈现，不补造缺源或整集音频；合并包sample仅表示节选，内容保持private。前端沿用现有分季目录和阅读进度契约。导入、完整性及权限验收见 [Bluey上线记录](deploy/BLUEY-IMPORT-2026-10-04.md)。

Bluey 后续复核以实际音频为准，PDF、字幕和ASR仅作辅助参考。单纯PDF措辞不同不构成音频错误或禁播的充分依据；存在其他识别、切点或重叠对白问题时，应分别对照原声判断。此规则澄清尚未重发线上内容，上述当前播放计数不变，也不表示已将待复核条目人工听校通过。
