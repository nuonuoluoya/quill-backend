# 收藏后端生产发布（2026-10-05）

用户在后端任务直接要求“部署生产”。本次部署后端和新增收藏表，不上传、提审或发布小程序。

## 发布身份

| 项目 | 结果 |
| --- | --- |
| 代码 | a6b04b417f6920e284710878a3f45dafeb14e494；收藏实现 a79adbb |
| 完成时间 | 2026-10-05T14:47:12Z / 北京时间22:47:12 |
| 镜像 | quill-backend:a6b04b4 |
| 镜像ID | sha256:2b49f878e22e4a91f342a33ffc0b2bc15f602e41497c8d63674d3cdbec790400 |
| OCI revision | a6b04b417f6920e284710878a3f45dafeb14e494 |
| 归档SHA256 | 3f678246a26505858397758908eb4b0c32fd7b5f0fc90e195150cdabbf100173 |
| Node | 22.23.2，Dockerfile固定基础镜像 |
| 发布目录 | /opt/quill-listening/releases/a6b04b4 |
| 运维证据/备份目录 | /opt/quill-listening/operations/20261005-favorites（root受限目录） |
| 回退镜像 | quill-backend:891889c |
| 回退镜像ID | sha256:c482fed13bd84c4f0b6a2eb0a949654fd0c3fea79be1eac967fa0e2e57db5141 |

复用已通过的79项隔离测试及类型、Schema、OpenAPI、构建检查；服务器使用锁文件构建。001、Dockerfile和生产Compose与旧发布仅CRLF/LF换行编码不同，内容一致。准备脚本的Windows换行已规范后运行，未修改业务代码。

## 备份与迁移

业务库为quill，迁移前约602.6MB。服务器先生成custom格式 `quill-before-favorites.dump`：76,804,340字节、权限600，SHA256 `243ab5e7d6fcef8945a559a4d36c2f2689b2e08c9c8d686c3bb975ade043f920`。pg_restore清单读取与完整流解码到/dev/null均通过；没有向生产恢复数据，也没有把该检查当作完整恢复演练。备份留在受限运维目录，不上传Git或复制秘密配置。

生产权限分离为quill_owner负责表结构，quill_app只有业务增删改查。首次独立合成库演练直接使用API账号迁移，按预期权限边界被42501拒绝，正式库未受影响。随后通过既有管理入口连接并SET ROLE quill_owner执行001/002，每个脚本独立事务；001仍保持原内容，002仅新增收藏三表和索引。迁移设置5秒锁超时、30秒语句超时，失败不切换API。

新增表归quill_owner，quill_app沿用SELECT/INSERT/UPDATE/DELETE；没有授予CREATE、TRUNCATE或运行角色提升。已有默认授权已核对，显式确认三表业务授权。不要用生产API账号直接运行需要DDL的迁移CLI；应通过持有迁移权限的受控入口执行。

独立原生PostgreSQL库先完成两遍有序迁移，然后使用quill_app运行19项合成验收：五个HTTP接口、10个并发收藏写入、稳定版本、当前真值幂等、过期拒绝、游标冲突、第二账号隔离和失权脱敏。合成账号/会话仅存在临时库，演练完毕删除该库；生产测试收藏写入为0。此演练补充先前PGlite回归，不等同一万条生产并发压力测试。

## 切换与核对

- 正式迁移前后旧业务列结构指纹、旧业务受检数据指纹一致；候选使用默认只读数据库连接和只读媒体挂载，检查通过后Compose只替换API，不重启PG。
- 候选、正式本机、正式HTTPS各20项检查通过：五收藏路由匿名401、两个现有账号的只读服务层列表、健康与受保护就绪、公开HP1预览/342句正文、锁章404、私人访问401、签名媒体HEAD200/Range206且16字节匹配存储、无签名403。签名仅在验证进程中生成，不输出签名或私人正文。
- Windows独立公网复查在2026-10-05T22:48:45+08:00通过6项：live200、无凭据ready403、公开预览200、私人hp1-en401、收藏列表401、收藏status401。
- 前后2用户、30会话、14内容、15构建、22授权、8进度、114进度幂等、52审计的受检指纹相同；构建排除正常签发期限last_signed_until。2380章、339728句、300904音频的条数相同，未重哈希全部历史正文和媒体。新收藏三表初始均0记录。
- 原PG容器/镜像/启动时间/quill_pgdata卷保持；backend.env/postgres.env哈希保持，媒体仍挂载 `/var/lib/quill/media:/app/media:ro`。API健康、重启0，运行镜像与revision准确。候选容器与临时演练库已删除，旧镜像、正式媒体、备份及发布证据保留。结束时可用10,700,480,512字节，约10.70GB。

正式五收藏接口现已上线。小程序仍需正常发布流程；未为验证获取真实用户令牌、写生产测试收藏/进度、调用微信登录或录制麦克风。前端手势修复独立推进，后端上线不表示小程序已发布或真机听感已验收。

## API回退

若需要回退，保留收藏表、备份与媒体，只切回已核实旧API；旧版不提供收藏接口，前端应如实显示不可用。不要删除新表、down -v或恢复旧整库，否则可能丢失上线后的真实数据。

```sh
QUILL_IMAGE=quill-backend:891889c docker compose -p quill-prod \
  --env-file /etc/quill/deploy.env \
  -f /opt/quill-listening/releases/891889c/deploy/compose.production.yaml \
  up -d --no-deps --wait --wait-timeout 90 api
# 仅在旧API健康后同步镜像选择。
printf 'QUILL_IMAGE=quill-backend:891889c\n' > /etc/quill/deploy.env
chmod 600 /etc/quill/deploy.env
```

切换脚本已设置失败自动回退；本次检查全部通过，未触发回退。后续数据库恢复需要根据真实故障和新增数据单独制定，不作为常规API回退动作。
