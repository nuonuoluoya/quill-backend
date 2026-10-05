# 收藏接口与运维

2026-10-05：实现与隔离验收，尚未部署生产。规范来源为 `docs/SPEC.md` 中《收藏保存、接口与实施契约》；机器契约见 `contracts/openapi.yaml`，类型见 `contracts/src/index.ts`。

## 请求与账号

所有接口使用现有 `Authorization: Bearer ...`，身份来自会话，拒绝请求中的 userId 与未知字段。沿用 `{data,requestId}` / `{error,requestId}` 封装。游客仅由前端在本机保存，不调用账号收藏接口、不自动合并。

| 方法及路径 | 请求 / 结果 |
| --- | --- |
| PUT `/v1/me/favorites` | 四字段引用、sourceBuildId、clientMutationId、clientMutationCreatedAt → FavoriteWriteResult |
| DELETE `/v1/me/favorites/:favoriteId` | 两个 mutation 字段 → FavoriteWriteResult；失权仍可取消，不存在同样成功 |
| GET `/v1/me/favorites` | limit 1–50（默认20）、q、cursor → FavoritePage |
| POST `/v1/me/favorites/status` | bookId、textRevision、sourceBuildId、chapterId、1–200个不重复sentenceIds → FavoriteStatusResult |
| GET `/v1/me/favorites/:favoriteId` | 实时解析 → FavoriteItem；本人不存在404 |

以上成功均为 **200**，包括 POST status。列表、单项与批量状态支持 `X-Quill-Capabilities: review-audio-v1`，响应带 `Vary: X-Quill-Capabilities` 和 `Cache-Control: private, no-store`。缺省能力时待复核句的音频字段置空，数量按该投影统计。

```json
{
  "bookId": "a-quiet-morning",
  "textRevision": "original-text-v1",
  "chapterId": "c01",
  "sentenceId": "c01-s0001",
  "sourceBuildId": "original-speech-v1",
  "clientMutationId": "11111111-1111-4111-8111-111111111111",
  "clientMutationCreatedAt": "2026-10-05T12:00:00.000Z"
}
```

这是形状示例；实际点击生成新的 UUID 与当前 UTC 时间。请求不确定时重试必须保留原 UUID、时间和内容。新请求允许过去24小时至未来5分钟，过期409 `FAVORITE_MUTATION_EXPIRED`；应先刷新真值，由用户重新点击才创建新请求。同键不同内容409 `IDEMPOTENCY_KEY_REUSED`。已知重试先核摘要再返回**当前**状态/账户版本，不会重放旧成功响应或重新添加已取消的句子。

FavoriteWriteResult 为 `{favoriteId,saved,favoritedAt,version}`。稳定ID是 `SHA256(JSON.stringify([bookId,textRevision,chapterId,sentenceId]))`，不含 buildId；查询同时限定 user_id。重复添加保持时间和排序，只有实际增删才递增账户安全整数版本。每账号10000条含失效记录，满额新加409 `FAVORITES_LIMIT_REACHED`，重复添加和取消仍允许。

## 列表、脱敏与播放

FavoritePage 的 totalCount 包含全部本人收藏，matchedCount/playableCount 对完整搜索结果统计，不取当页长度。q 去首尾空白后最多100字符，按当前有权正文作不区分大小写的字面子串匹配，`%`、`_` 没有通配意义。空q包含失效条目，非空q不会搜索失权或旧正文。

按 added_version 倒序分页，HMAC 游标绑定账号、搜索、能力、位置及初始账户版本。收藏实际变化返回409 `FAVORITES_CHANGED`，前端清页重取；无效/跨作用域游标400 `INVALID_REQUEST`。版本未变不证明权限有效，每次查询仍核实授权。

FavoriteItem 固定字段为 favoriteId/favoritedAt/status/reference/resolvedBuildId/sentence/source/playable。available 按当前同正文活动构建解析，source 含书/章、类型及可空季/期/部分信息。forbidden、text_revision_changed、content_unavailable 的 reference、resolvedBuildId、sentence、source **全部为null**，playable=false，只留ID、时间和状态供取消。权限检查先于正文版本检查；恢复授权后重新解析。数据库等临时异常返回503，不把网络错误写成永久失效。

可读但没有音频的句子也可收藏。播放/定位前重新 GET 单项，再走已有源章节与 playback 鉴权接口；不保存签名URL，不延长授权或旧媒体寿命，不保存录音，不写阅读进度。收藏页的队列与跟读行为由前端实现。

## 迁移、转储与回退

- `npm run db:migrate` 按确定名单执行001、002，每个脚本单独事务且可重复。001保持原字节；002只新增三个收藏表及索引，只依赖users，不把收藏绑定到会退役的构建。开发启动保留既有自动迁移行为，production/staging 不自动迁移。
- 生产发布必须另行授权；发布时先按既有运维流程备份并显式迁移，再切换API。仅回退API时保留新表，避免丢收藏；本次没有执行这些生产动作。
- `npm run cli -- maintenance` 清理30天前的收藏幂等记录。清理后，旧请求仍被原始时间窗口拒绝。保留正常数据库统计维护，幂等账本随30天写入量滚动，不承诺固定字节上限。
- `npm run data:transfer -- export FILE` 输出 `quill-transfer-v2`，包含旧11表与新增3表；import/verify对全部表和审计序列验证。导入前须在独立空目标库执行迁移；目标任一业务表非空即拒绝。严格旧v1文件被标准化为三个空收藏表，不接受混入新表的伪v1，不覆盖或默默丢弃已有收藏。

## 隔离验收

测试使用临时目录、原创/合成夹具、PGlite内存或临时磁盘库，不读取生产配置或账号。覆盖五个HTTP路由/DTO、幂等当前真值、重试摘要、超期与清理、账号隔离、权限恢复和脱敏、同正文换构建、正文变化、批量状态、游标作用域/409、无音频与能力投影、10000上限、重复迁移/旧库升级及v1/v2转储精度和回滚。

性能原始证据见 `favorites-performance-2026-10-05.json`：10000条混合状态，每种状态2500条；每次列表只有一条SQL快照，最多50条当页来源解析，额外一条只用于判断下一页。SQL聚合全量计数与搜索，来源元数据在分页后解析，无逐句manifest/媒体读取、无应用层N+1。

测量前对批量合成数据执行ANALYZE。此Windows、Node24.11.0、PGlite/PostgreSQL WASM结果只代表隔离环境，不等同生产网络延迟或原生PostgreSQL高并发验收。早期未更新统计的单一状态夹具曾约4.8秒，更新统计后降至数十毫秒；真实生产数据规模下仍应检查自动统计与执行计划。普通分页需要全量权限/搜索计数，不宣称只扫描50条。