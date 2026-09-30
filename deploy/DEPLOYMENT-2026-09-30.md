# 2026-09-30 HTTPS 与新版后端部署记录

## 当前状态

后端公网部署已完成。`https://codingluke.site/v1` 已由 Nginx 转发到新的 Docker API，`/media/` 保留原始路径和签名查询参数。小程序生产地址、微信合法域名配置、真实微信登录及 iOS/Android 真机验收尚待完成；不能将后端验收等同于小程序已经发布。

## 运行版本与持久化

- 代码提交：`93f282a`；镜像：`quill-backend:93f282a`。
- 发布目录：`/opt/quill-listening/releases/93f282a`；运行镜像选择文件：`/etc/quill/deploy.env`。
- 镜像摘要：`sha256:db466760c9bcc199437c6e95f4057f47249dbe2df2888a3a39efa0f79d37632e`。
- Compose 文件：上述发布目录的 `deploy/compose.production.yaml`，项目名 `quill-prod`。
- API：`quill-prod-api-1`，健康，宿主机仅绑定 `127.0.0.1:3210`。
- PostgreSQL：`quill-prod-postgres-1`，沿用固定卷 `quill_pgdata`，不开放宿主机端口，未重建或重启数据库。
- 音频继续使用 `/var/lib/quill/media`，API 只读挂载；生产秘密配置保持在 `/etc/quill`。
- 相比原生产版本 `dae2393`，迁移文件无变化，本次未执行 DDL、数据重导入或本地 `.data` 上传。

## 证书与自动续期

已核对磁盘证书与实际 HTTPS 提供的证书一致，证书链验证成功。当前有效期为北京时间 2026-09-30 12:39:03 至 2026-12-29 12:39:02。

续期方式已由 standalone 改为 webroot，目录 `/var/lib/quill/acme`。root cron 每天 03:00 执行 `certbot renew --quiet --post-hook 'systemctl reload nginx'`；crond active 且 enabled。`certbot-renew.timer` 未启用，但 cron 已承担调度，不重复启用另一任务。2026-09-30 13:39 的 Certbot 日志显示模拟续期成功。

## 发布前验证与依赖修补

本地类型检查、32 项测试、Schema 检查、OpenAPI 契约检查和构建通过。最终镜像在服务器隔离测试库中再次通过 32 项测试，其中 29 项 HTTP/业务测试连接真实 PostgreSQL；临时测试数据库、角色和配置已删除。

原候选版本 `3911231` 构建时发现 4 个 moderate 审计条目，源于两个传递依赖：Multer 与 js-yaml。保持 NestJS/Swagger 主版本，锁定 Multer 2.4.0 和 Swagger 使用的 js-yaml 5.4.1 后重新检查、提交并构建 `93f282a`。本地及镜像生产依赖审计均为 0 已知漏洞。公告见 [Multer](https://github.com/advisories/GHSA-3pph-fpjx-jg34) 和 [js-yaml](https://github.com/advisories/GHSA-r3ph-w7gj-g6xm)。

## 切换和公网验收

首次切换中新 API 本机健康及数据摘要检查通过，但 Nginx 重载后立即请求公网得到 404，发布脚本自动恢复原 API 与代理配置。核对配置无域名冲突后加入 Nginx 重载的有界就绪等待，再次切换成功。由此可见首次检查过早命中了切换窗口；后续应轮询实际就绪状态，不能仅凭重载命令退出即认定新路由已生效。

验证结果：

- HTTPS `/v1/health/live` 返回 200；就绪接口带正确凭据返回 200，未授权访问返回 403。
- 未登录访问 `/v1/me`、私有书架返回 401。
- `book/blog/movie/tv` 分类正常；书籍分类返回 2 个原有样本，其余分类为空；非法类型和跨类型复用游标返回 400。
- 公共内容为 2 本书、6 章、48 句，正文读取正常。
- 全部 52 个音频通过磁盘哈希、HTTPS 完整下载哈希、Content-Type、HEAD 长度及 Range 前 16 字节验证；无签名或无效签名访问被拒绝。
- 部署前后 11 张业务表的数量和完整行摘要一致。摘要核对后又执行真实公开样本播放授权，正常推进对应构建的 `last_signed_until`；没有创建测试用户或阅读进度。
- 从服务器之外的 Windows 主机独立验证 HTTPS、API、分类、章节、真实样本播放授权、完整 MP3 和 Range 下载，全部通过。签名 URL 和配置凭据未写入本记录。

生产媒体仍为 52 个文件。后续本地导入的 Harry Potter 等私人内容及手机账号授权未在本次发布中同步，需要单独执行内容导入、发布和账号授权。

## 旧应用清理与回退

公网验收后，按用户既有授权核实真实路径、PM2 工作目录及 Docker 挂载，删除旧 PM2 `quill-api`、`/home/quill-backend` 和 `/home/quill-backend.tar.gz`，并保存新的 PM2 列表。未操作 MySQL，未删除 PostgreSQL 卷、音频目录或上一版新项目镜像。

上一版新后端 `quill-backend:dae2393` 与发布目录保留。必要时只回退 API 镜像，仍使用新的 3210 代理和原数据；验证健康后再更新 `/etc/quill/deploy.env` 的 `QUILL_IMAGE`。不得执行 `down -v` 或数据清空。`dae2393` 不含最新多类型功能，且依赖审计状态较旧，只作紧急恢复用途。

本次没有重新执行用户已取消的数据库备份，也没有设置数据库备份任务。

## 下一步

将小程序生产 API 设置为 `https://codingluke.site/v1`，配置实际 request/downloadFile 合法域名，恢复域名与证书校验，用新的微信登录 code 完成真实登录、权限、播放和进度同步验收。生产当前无用户，因此不能把开发者工具或本地数据库中的账号授权直接视为线上已有授权。
