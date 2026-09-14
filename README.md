# 微文档

个人云笔记 + 办公文件柜。Go + PostgreSQL + React，浏览器访问，支持 Windows / Linux 部署。

## 功能

- 登录鉴权、首次安装向导
- 左侧目录树 / 右侧内容区
- Markdown 编辑与预览（自动保存）
- Word / Excel / PPT / PDF（ONLYOFFICE）
- 上传、重命名、复制、回收站、搜索
- 管理员用户管理

## 本地开发

### 1. 启动数据库

```bash
docker compose -f deploy/docker-compose.yml up -d postgres
```

### 2. 配置数据库

在 `apps/api/.env` 中填写本机 PostgreSQL（已支持 `DB_HOST` 等拆分字段）：

```env
DB_HOST=192.168.2.30
DB_PORT=5432
DB_USER=postgres
DB_PASSWORD=你的密码
DB_NAME=weidoc
HTTP_ADDR=:8088
PUBLIC_BASE_URL=http://localhost:8088
```

并创建库：

```bash
psql -h 192.168.2.30 -U postgres -c "CREATE DATABASE weidoc;"
```

### 3. 启动 API

```bash
cd apps/api
go run ./cmd/server
```

### 4. 启动前端

```bash
cd apps/web
npm install
npm run dev
```

浏览器打开 http://localhost:5173 ，首次进入创建管理员账号。

```bash
docker compose -f deploy/docker-compose.yml up -d onlyoffice
```

确保浏览器、API、OnlyOffice 彼此可访问。Windows 本机开发时：

- `PUBLIC_BASE_URL=http://host.docker.internal:8080`（给容器回调用时需额外配置）
- 浏览器访问的 `ONLYOFFICE_URL` 一般为 `http://localhost:8081`

## 一键部署

```bash
cd deploy
copy .env.example .env   # 按需修改
docker compose up -d --build
```

访问 http://localhost:8080

## 目录结构

```
apps/api     Go 后端
apps/web     React 前端
deploy       Docker Compose / Dockerfile
docs         产品与开发文档
```

更完整的规格见 `docs/产品与开发文档.md`。
