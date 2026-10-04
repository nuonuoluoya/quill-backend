# 后端联合审查修复生产部署（2026-10-04）

用户明确授权部署后端代码后，将已审查版本上线。本次仅替换 API；后续 Bluey 内容导入独立记录。

## 运行版本

| 项目 | 结果 |
| --- | --- |
| 上线代码 | 3d7e7019507b358829382d73a313bce5e4d76870（包含18a1bc4业务修复） |
| 切换完成 | 2026-10-04T04:03:31Z / 北京时间12:03:31 |
| 镜像 | quill-backend:3d7e701 |
| 镜像ID | sha256:cf8f47532816b084fcccefcaaf6bd9aab6536899ce5765089c285645a33922a4 |
| 代码归档SHA-256 | c3d273f62e078f224cc2b448917c249742c49e326d7edfa4a4c42bd9361622b7 |
| 发布目录 | /opt/quill-listening/releases/3d7e701 |
| 固定基础镜像内Node | v22.23.2 |
| 回滚代码/镜像 | 52e93ce / quill-backend:52e93ce |
| 回滚镜像ID | sha256:c4bc7e99db4be8560aa05183862acde2a6c7988a21821a9e35d843f5f4058022 |

GitHub与本地目标提交一致，工作区无未知代码修改。修复登录路径大小写/单尾斜杠限流绕过、健康路径误豁免、重复导入可见性冲突，以及OpenAPI在Windows下的换行误报；测试工具固定Vitest4.1.11。Dockerfile、生产Compose及迁移内容与52e93ce一致；旧归档CRLF、新归档LF，比较仅忽略行尾CR。

## 构建与切换

- 复用同提交的44项回归：Node24.11.0和22.12.0均通过；22.12.0下源码与测试配置类型、Schema/OpenAPI、构建通过。完整及omit=dev审计均0项，生产依赖版本/完整性不变。
- 服务器按固定基础镜像与锁文件执行npm ci、tsc构建及生产依赖裁剪成功。镜像OCI revision、实际运行镜像ID均核对准确；没有在生产容器安装Vitest或启动测试服务。
- 候选容器不发布端口，数据库默认只读，媒体只读挂载；14项检查通过后使用既有Compose项目、`up --no-deps --wait api`仅替换API，配置失败自动回退。实际无需回退。
- `/etc/quill/backend.env`及`postgres.env`原位保留，前后哈希一致，未新增秘密副本；`deploy.env`仅更新QUILL_IMAGE。PostgreSQL容器ID、镜像、启动时间及quill_pgdata挂载前后一致，媒体仍为`/var/lib/quill/media:/app/media:ro`。

## 验收结果

候选、正式本机与正式HTTPS分别通过14项：live200；ready无凭据403、带现有凭据200；混合大小写健康HEAD200；公开列表、第一章详情/正文200；锁章404；匿名hp1-en、English Pod及member播客查询401；签名媒体HEAD200、Range206且16字节与存储一致，未签名媒体403。服务端媒体抽样仅在进程内生成短期签名，不输出签名，不调用playback接口；数据库查询使用只读事务。

切换前后12项内容、12个构建、18条授权、6条阅读进度、68条进度幂等记录、42条内容审计的计数及指纹全部一致。构建指纹排除正常媒体签发会更新的last_signed_until。没有导入、发布内容、改授权、创建账号、写进度、访问录音或执行DDL；未在生产进行限流压力测试。

统筹任务在Windows独立复查，本机记录时间为2026-10-04T20:59:53.6356397+08:00：live200、无凭据ready403、私人书匿名401；预览构建first-chapter-c70805877324dc1c5616ed33及342句正文200；真实匿名playback201、媒体HEAD200/Range206且16字节。该正常签发会推进last_signed_until，但不写用户进度或授权。首个执行会话结果不可读取后重跑成功，不将会话丢失视为服务故障，也不宣称恰好签发一次。此轮不重复微信登录、真机听感或完整素材校验。

已停止并删除本轮候选容器，保留正式API、旧镜像、发布目录及受限运维证据。最终API/PG健康，API重启次数0；磁盘使用约55%，可用约19GB。首次候选检查脚本漏取响应data层，修正验收脚本后通过，未修改业务代码。

## 回滚

如本次代码发生回归，在服务器执行下列有限操作；保留数据库、媒体与秘密配置，禁止down -v或恢复旧数据库：

```sh
QUILL_IMAGE=quill-backend:52e93ce docker compose -p quill-prod \
  --env-file /etc/quill/deploy.env \
  -f /opt/quill-listening/releases/52e93ce/deploy/compose.production.yaml \
  up -d --no-deps --wait --wait-timeout 90 api
# 仅在旧API健康后同步镜像选择；当前文件只有QUILL_IMAGE。
printf 'QUILL_IMAGE=quill-backend:52e93ce\n' > /etc/quill/deploy.env
chmod 600 /etc/quill/deploy.env
```

52e93ce保留现有预览/赠书/播客契约，但不包含本轮限流和导入幂等修复；回滚后应安排对应修复。回滚不撤销内容或用户授权。
