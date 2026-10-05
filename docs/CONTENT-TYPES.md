# 内容分类、电视剧分季与播客分期

五类素材都提供文字和截取后的句子音频，不提供视频资源或视频播放。现有 `/v1/books`、`bookId`、`chapterId`、句子播放和进度接口继续兼容；内容类型不会改变音频路径或访问权限。

## 分类查询

```http
GET /v1/books?contentType=book
GET /v1/books?contentType=blog
GET /v1/books?contentType=movie
GET /v1/books?contentType=tv
GET /v1/books?contentType=podcast
GET /v1/books
```

不传 `contentType` 查询全部类型；不接受 `all`、空值或其他类型。`audience=sample|member`、`limit`、`cursor` 与类型参数组合使用。服务端先按当前活动构建的类型和用户权限筛选，再分页。返回结构仍为 `{data:{items,nextCursor},requestId}`。

切换类型、样本/我的内容或账号时，客户端清空游标并重新查询；跨筛选条件复用游标返回 400。旧版无类型游标仅能用于全部查询。服务端支持分类查询后，前端可以用一次按类型分页请求替代混合列表扫描；本次没有修改前端调用。

列表摘要增加 `contentType`、`unitCount`、`seasonCount`，以及可选 `coverUrl`。`unitCount` 是学习单元数量，与 `chapterCount` 一致：书籍按章、博客按篇、电影按段、电视剧按集。摘要不包含正文、完整季目录或剧集数组。

## 内容详情与季目录

`GET /v1/books/:bookId` 或 `/v1/books/:bookId/builds/:buildId` 返回 `seasons` 和既有 `chapters`。客户端根据 `seasons.length` 决定电视剧的目录布局：

- 空数组：直接展示剧集，`chapters` 条目带 `episodeNumber`。
- 非空数组：按季的 `order` 排序，通过 `chapter.seasonId` 归组；每季内按 `episodeNumber` 展示。

单集接口 `/v1/books/:bookId/builds/:buildId/chapters/:chapterId` 同样返回对应的 `episodeNumber` 和可选 `seasonId`。播放授权和进度提交仍使用唯一的 chapterId / sentenceId，不使用“第几季、第几集”作为数据库身份。同一部电视剧仍保存一个最近学习位置，可由详情目录定位到季、集和句子。

## 导入格式

继续使用 `schemaVersion: 2` 的 `book.json` 和章节文件。在 `book.json` 顶层添加可选的 `contentType`、`coverUrl` 和 `seasons`，在其 `chapters` 条目添加剧集字段。基础 v2 Schema 保持不变，扩展 Schema 为 `contracts/schemas/content-metadata.schema.json`，导入时同时执行结构与语义校验。

以下为添加到现有包的字段片段，省略了原有必填身份、时长、计数和 data 路径，不是可单独导入的完整包：

```json
{
  "contentType": "tv",
  "seasons": [
    {"id": "s1", "title": "第一季", "order": 1},
    {"id": "s2", "title": "第二季", "order": 2}
  ],
  "chapters": [
    {"id": "s1-e01", "seasonId": "s1", "episodeNumber": 1},
    {"id": "s1-e02", "seasonId": "s1", "episodeNumber": 2},
    {"id": "s2-e01", "seasonId": "s2", "episodeNumber": 1}
  ]
}
```

- 不分季电视剧只填 `contentType: "tv"`，省略 `seasons` 或设为空数组；不填 `seasonId`。`episodeNumber` 可省略，按章节顺序从 1 生成；最终序号必须递增且不重复。
- 分季电视剧的季 ID 唯一，季 order 为唯一正整数且数组递增；每季至少有一集。所有剧集必须提供有效 seasonId 和正整数 episodeNumber，章节数组先按季再按集排序，同季集号不能重复，可有间隔。
- 不同季可以重复显示“第 1 集”，但集 ID 和句子 ID 仍须满足整部内容构建内的唯一性约束。
- 书籍、博客、电影不接受 seasons、seasonId 或 episodeNumber 输入字段。
- `coverUrl` 可选，必须为不含账号密码的 HTTPS URL；后端不下载此地址。前端使用时需配置对应域名，并保留封面失败回退处理。
- `unitCount`、`seasonCount` 和 `episodeCount` 由服务端计算，不由导入方指定。
- 省略 contentType 的旧包默认 book。已经入库的旧快照在读取时补字段，不改写原有元数据、摘要、媒体或进度。

目录变化生成新的 buildId。仅改季标题或分组且正文身份/顺序不变时，可以保留 textRevision；改变正文、增删剧集或分句身份按既有规则更新 textRevision。既有进度不会因改季标题自动清零；旧构建保留期和冲突规则继续生效。

## 发布注意

本次使用已有 JSONB 构建元数据，不新增表、不要求重建数据库或重新导入旧内容。更新 API/CLI 版本后才能使用新字段；只需为新类型内容导入真实音频包。当前服务端已有书籍不会自动变成其他类型，缺少内容的分类返回空列表。

后端提供分类和季信息，前端类型请求及季目录交互需要对应接入。服务器上当前运行的版本以生产部署记录为准，GitHub 提交不等于生产镜像已更新。


## 播客节目与分期

`contentType=podcast` 是独立播客类型。前端播客替换原博客标签，分类栏保持五项；`blog` 仅保留历史数据/API 兼容，在全部列表中可达。服务端按类型和权限筛选后分页，客户端不扫描所有类型拼出播客列表。

每个节目对应一个 bookId。摘要新增 `episodeCount` 表示期数（非播客为 0），`chapterCount/unitCount` 仍表示实际学习部分数量。摘要不含 `episodes/chapters`；详情新增 `episodes`，其他类型返回空数组。

```json
{
  "contentType": "podcast",
  "episodes": [
    {"id": "ep001", "number": 1, "title": "Difficult Customer"},
    {"id": "ep002", "number": 2, "title": "A New Topic"}
  ],
  "chapters": [
    {"id": "ep001-dg", "episodeId": "ep001", "part": "dialogue", "title": "对话"},
    {"id": "ep001-pb", "episodeId": "ep001", "part": "lesson", "title": "教学"},
    {"id": "ep002-pb", "episodeId": "ep002", "part": "lesson", "title": "教学"}
  ]
}
```

上例省略既有必填字段。章节正文同样返回 `episodeId/part`。期 ID 唯一、number 为递增正整数；每期至少一个部分，同期 dialogue/lesson 各最多一个；章节先按期号再按 dialogue、lesson 排列。播客不接受电视剧季集字段，其他类型不接受播客字段。缺失部分不生成假章节，由前端显示“素材缺失”并禁用，不隐藏整期。

交互为“播客 → 节目 → 按期列表原地展开对话/教学 → 阅读播放”，期号和主题同时显示，长目录支持搜索和分批显示。进入或展开不自动播放。同节目仍保存一个最近学习位置，用 chapterId 定位到期及部分，既有正文版本和账号隔离规则不变。

## English Pod 适配

在项目根目录运行，输出必须是源目录之外的新目录，已存在则拒绝覆盖：

```powershell
npx.cmd tsx scripts/prepare-englishpod.ts D:\resource\segment\EnglishPod D:\quill-backend\.data\englishpod-package
npm.cmd run cli -- validate D:\quill-backend\.data\englishpod-package
```

工具要求连续 365 期，生成导入包 `englishpod-en`，标题 `English Pod`。dg 为对话、pb 为教学；ID 加期号前缀以避免重复。仅复制通过原审核的逐句 MP3，保留文本、审核状态与原因；待复核音频置空且不上传。源元数据及可播放音频哈希决定 buildId；章节/句子身份、顺序和正文决定 textRevision。原始文件不改动，报告写入输出目录，不提交私人素材到 Git。

缺教学：32、43、58、337；缺对话：96、158、164、288。合集 contentScope=sample 表示材料不完整，导入时必须选择 private，不得改为公开样本。不自动合成整期音频。

生产先部署支持 podcast 的 API/CLI，再使用现有 import/publish/grant 流程。代码推送不等于素材上线；需验证实际音频时长、完整性、权限和缺源目录。

## 待复核音频

仅在运营方明确允许时，导入包book.json顶层设置 `allowReviewAudio: true`。此时needs_review句可以提供真实audio路径和有限正duration，但必须保留非空alignment.reasons；也可保留null/null表示缺源。默认不启用，unmatched/excluded始终不开放音频；格式、时长、哈希与引用校验不放宽。playableCount统计实际可播放音频，不能由“待复核”状态直接推断缺源。

支持该能力的客户端读取内容时发送 `X-Quill-Capabilities: review-audio-v1`。返回needs_review且有有效audioId/duration的句子允许播放。阅读页按用户最新要求隐藏待复核文案和原因，缺音统一显示“暂无逐句音频”并禁用；服务端仍保留审核状态及原因。没有能力头的列表/详情/章节按旧语义投影为待复核空音频并扣除相应计数，保持旧客户端可读。能力头不替代身份/书籍授权；分页游标不能跨能力模式复用，内部reviewAudioCounts不属于公开DTO。

## 单部分播客

节目可在book.json顶层声明 `podcastParts: ["lesson"]`（或只dialogue、按顺序的两者），数组非空、不重复且按dialogue在lesson前排序。省略按历史双部分处理；非播客禁止此字段，每个章节part必须在声明内。该字段随导入保存，仅在Book详情/固定构建中返回，不出现在BookSummary列表；未声明的历史快照保持原样。

前端按节目声明生成各期的部分入口，只对声明了却没有素材的部分显示缺源，不能按当前章节集合反推节目格式。Daily Easy English使用单lesson，每期保留完整教学和其中的例句/对话；English Pod缺省仍展示对话/教学及已记录的8处缺源。期号可有间隔，不补造缺失整期；全节目进度和原chapterId/sentenceId不变，待复核播放继续使用review-audio-v1能力协商。