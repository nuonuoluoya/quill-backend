# 本地 PostgreSQL 集成环境

在 `D:\quill-backend\deploy` 执行：

```sh
docker compose up --build -d
docker compose exec api node dist/src/cli.js seed
```

微信开发者工具导入 `D:\Quill`。数据库映射到本机 54329，API 映射到本机 3210，均只绑定回环地址。默认数据库口令仅用于本地演示，生产请使用独立秘密配置。已有本地 API 占用 3210 时先停止它。

API / PostgreSQL 使用独立命名卷，不自动加载本机 `.data` 中的 PGlite 数据。`docker compose down` 保留卷。不要在有需保留数据时使用 `down -v`。生产部署顺序参见 [独立 PostgreSQL 部署流程](PRODUCTION-PLAN.md)；专用生产配置为 `compose.production.yaml`，不能直接使用本开发示例上线。

本地开发 Compose 尚未运行验收。服务器独立生产 Compose 已启动并通过 PostgreSQL、接口、媒体及重启验证；公网仍受备案拦截影响，详见 [部署记录](DEPLOYMENT-2026-09-20.md)。
