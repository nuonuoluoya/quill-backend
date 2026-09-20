# 内容分类与电视剧分季

四类素材都提供文字和截取后的句子音频，不提供视频资源或视频播放。现有 `/v1/books`、`bookId`、`chapterId`、句子播放和进度接口继续兼容；内容类型不会改变音频路径或访问权限。

## 分类查询

```http
GET /v1/books?contentType=book
GET /v1/books?contentType=blog
GET /v1/books?contentType=movie
GET /v1/books?contentType=tv
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
- `unitCount` 和 `seasonCount` 由服务端计算，不由导入方指定。
- 省略 contentType 的旧包默认 book。已经入库的旧快照在读取时补字段，不改写原有元数据、摘要、媒体或进度。

目录变化生成新的 buildId。仅改季标题或分组且正文身份/顺序不变时，可以保留 textRevision；改变正文、增删剧集或分句身份按既有规则更新 textRevision。既有进度不会因改季标题自动清零；旧构建保留期和冲突规则继续生效。

## 发布注意

本次使用已有 JSONB 构建元数据，不新增表、不要求重建数据库或重新导入旧内容。更新 API/CLI 版本后才能使用新字段；只需为新类型内容导入真实音频包。当前服务端已有书籍不会自动变成其他类型，缺少内容的分类返回空列表。

后端提供分类和季信息，前端类型请求及季目录交互需要对应接入。服务器上当前运行的版本以生产部署记录为准，GitHub 提交不等于生产镜像已更新。
