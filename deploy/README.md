# 本地 PostgreSQL 集成环境

在 `D:\quill-backend\deploy` 执行：

```sh
docker compose up --build -d
docker compose exec api node dist/src/cli.js seed
```

微信开发者工具导入 `D:\Quill`。数据库映射到本机 54329，API 映射到本机 3210，均只绑定回环地址。默认数据库口令仅用于本地演示，生产请使用独立秘密配置。已有本地 API 占用 3210 时先停止它。

API / PostgreSQL 使用独立命名卷，不自动加载本机 `.data` 中的 PGlite 数据。`docker compose down` 保留卷。不要在有需保留数据时使用 `down -v`。生产配置参见项目 `../README.md`。

本次环境没有 Docker，此文件已编写但未声称通过容器启动验收。独立 Node 启动和 PGlite 集成测试已另行验证。
