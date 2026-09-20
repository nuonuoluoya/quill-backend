# 2026-09-20 PostgreSQL 部署记录

## 当前结论

服务器内部部署与数据迁移已完成；公网发布尚未完成。`codingluke.site` 的 A 记录正确，但外部 HTTP 请求被腾讯云重定向至备案拦截页，HTTPS 握手亦未成功。证书续签、Nginx 新 API 路由切换、小程序生产地址、真实微信登录和真机验收待继续。

## 已运行的版本和位置

- 服务器：`101.42.51.29`；应用代码提交：`dae2393`，前序部署实现提交：`6e8f832`。
- 发布目录：`/opt/quill-listening/releases/dae2393`；应用镜像：`quill-backend:dae2393`。
- Compose：上述发布目录中的 `deploy/compose.production.yaml`；镜像选择文件：`/etc/quill/deploy.env`。
- API：`quill-prod-api-1`，只绑定 `127.0.0.1:3210`，健康检查通过。
- PostgreSQL：16.15，容器 `quill-prod-postgres-1`，没有宿主机端口映射；持久卷 `quill_pgdata`。
- 音频：`/var/lib/quill/media`，API 只读挂载，52 个文件共 2,318,120 字节。
- 秘密配置：`/etc/quill/backend.env`、`postgres.env`、`migration.env`；目录 0700、配置 0600，未进入 Git/镜像。生产 `PUBLIC_BASE_URL=https://codingluke.site`。
- 数据库迁移使用 `quill_owner`，API 使用 `quill_app`；运行账号无建表权限。
- Docker 开机启动已启用，服务采用 `restart: unless-stopped`。使用按摘要锁定的 Docker 官方 ECR Node/PostgreSQL 镜像，未配置第三方 registry mirror。

## 数据与验证

| 数据 | 数量 |
| --- | ---: |
| books / book_builds | 2 / 2 |
| chapters / sentences | 6 / 48 |
| audio_assets | 52 |
| content_audits | 4 |
| users / sessions / book_access / reading_progress / progress_mutations | 均为 0 |

本地 PGlite 正常停止后导出，再恢复本地 API；源数据保留。只向空的新 PostgreSQL 事务导入，保持 ID、对象键、时间、版本与审计序列。API 和 PostgreSQL 重启后再次校验，11 张表的记录数、逐行内容摘要及审计序列全部一致。

- 类型、构建、Schema、OpenAPI 契约检查通过。
- 本地 25 项测试通过；服务器 25 项测试通过，其中 22 项集成测试连接独立真实 PostgreSQL 测试库，其余为迁移及生产启动测试。
- Ajv 8.20.0、Multer 2.3.0 已锁定；`npm audit --omit=dev` 无已知漏洞，生产镜像依赖审计亦通过。
- API 存活、带凭据就绪检查通过；无凭据就绪检查拒绝访问。
- 实际运行账号连接成功，建表尝试返回权限拒绝，测试事务已回滚。
- 全部 52 个音频磁盘哈希、签名下载哈希、HEAD 长度、Range 前 16 字节检查通过；无签名访问拒绝。
- 生产服务器回环地址 50 并发公开书架读取：零错误，p95 76.9 ms。此结果不代表公网延迟或真机性能。
- 公开样本书架返回 2 本书。私有权限、进度读写与冲突通过隔离数据库集成测试；未虚构真实用户登录。

迁移文件只作中间产物，校验后清理；没有创建备份、执行 MySQL 备份或设置备份任务。

## 公网阻塞的证据

- 用户 DNS 截图及公共 DNS 查询均显示根域名 A 记录为 `101.42.51.29`，TTL 600。
- 服务器本机访问 ACME 验证文件返回 200；外部使用正确 IP 并指定域名仍收到 302，目标为 `https://dnspod.qcloud.com/static/webblock.html?d=codingluke.site`。
- 腾讯云拦截页使用的域名状态接口返回 `GovStatus=false`、`LandedStatus=false`、`AuditTicket=false`、`Ban=false`。应在工信部及腾讯云备案控制台核查备案/接入记录；DNS 配置无需因本次错误重填。
- Certbot HTTP-01 因上述拦截返回 unauthorized；现有证书已于 2026-08-12 到期，新证书没有签发成功，续期机制尚待验证。
- 已给现有 HTTP Nginx 配置增加 ACME webroot；HTTPS 路由仍指向旧应用 3000，没有把新应用声明为公网可用。

## 继续执行的位置

1. 核实并解决备案/腾讯云接入限制，确认外部 HTTP 请求能到达该服务器。查询入口：[工信部](https://beian.miit.gov.cn/)、[腾讯云备案控制台](https://console.cloud.tencent.com/beian)。
2. 使用 `/var/lib/quill/acme` webroot 续签 `codingluke.site` 证书，检查完整证书链；配置并验证定时续期与 Nginx 重载。
3. 新库和音频已经导入，**不要重新导入、初始化或删除数据卷**。如需启动现有版本：

   ```sh
   docker compose --env-file /etc/quill/deploy.env \
     -f /opt/quill-listening/releases/dae2393/deploy/compose.production.yaml up -d
   ```

4. 按 `PRODUCTION-PLAN.md` 复核并切换 Nginx，保留 `/v1` 和 `/media` 原路径，日志不记录签名查询串。公开 HTTPS 接口和签名音频验证成功后，删除已授权的旧项目 `/home/quill-backend`、旧归档及对应 PM2 `quill-api` 项目，保留共享 MySQL。
5. 更新小程序生产 API 基址 `https://codingluke.site/v1` 并配置微信合法域名；真实 `wx.login` 与 iOS/Android 联调完成后再报告上线。

旧应用因阶段五尚未通过而暂留；本地开发地址未切换为当前不可用的公网地址。用户撤销的备份步骤保持取消。
