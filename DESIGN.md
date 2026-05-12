# xiaoshouyi-cli 设计文档

## 概述

`xiaoshouyi-cli` 是一个面向 AI Agent 的销售易 CRM 命令行工具，对标 DWS（钉钉全产品 Skill），让 Agent 能通过标准 CLI 接口操作 CRM 数据。

## 销售易 REST API 模型

销售易采用**统一对象模型**，所有 CRM 对象共用同一套 CRUD 接口，通过 `apiKey` 区分对象类型。

### API Base URL

- **认证**: `https://login.xiaoshouyi.com`
- **数据**: `https://api.xiaoshouyi.com`（根据租户环境可能变化，如 `https://api-p05.xiaoshouyi.com`）

### 认证方式

OAuth2 Password Grant：

```
GET https://login.xiaoshouyi.com/auc/oauth2/token
  ?grant_type=password
  &client_id=<client_id>
  &client_secret=<client_secret>
  &username=<username>
  &password=<password><security_token>
```

> password = 用户密码 + 8位安全令牌（直接拼接，无分隔符）

### 接口规范

| 操作 | HTTP | 路径 | Content-Type | 说明 |
|------|------|------|-------------|------|
| 对象描述 | GET | `/rest/data/v2.0/xobjects/{apiKey}/description` | — | 获取字段元数据、权限 |
| SQL 查询 | GET | `/rest/data/v2/query?q=<SQL>` | — | 列表/搜索，每页100条 |
| 获取单条 | GET | `/rest/data/v2/objects/{apiKey}/{id}` | — | 获取某条记录 |
| 新建 | POST | `/rest/data/v2/objects/{apiKey}` | application/json | `{"data": {...}}` |
| 更新 | PATCH | `/rest/data/v2/objects/{apiKey}/{id}` | application/json | `{"data": {...}}` |
| 删除 | DELETE | `/rest/data/v2/objects/{apiKey}/{id}` | — | 不可逆 |

### SQL 查询语法

- 支持子句: `select`, `from`, `where`, `order by`, `limit`
- select 不支持 `*`
- where 操作符: `=`, `!=`, `like`, `not like`, `in`, `not in`, `is null`, `is not null`, `>`, `<`, `>=`, `<=`, `between ... and ...`
- like 仅支持后缀通配: `field like 'value%'`
- order by 仅支持 `id` 字段
- 分页: `limit offset,size`（如 `limit 0,20`）

### 响应格式

```json
{
  "code": 200,
  "msg": "操作成功",
  "result": { ... },
  "ext": [ ... ]
}
```

查询列表时 `result` 结构：
```json
{
  "totalSize": 2,
  "count": 2,
  "records": [ { "id": 2048503, ... }, ... ]
}
```

### 目标对象 apiKey

| 业务对象 | apiKey | 说明 |
|----------|--------|------|
| 客户 | `account` | 客户/公司信息 |
| 商机 | `opportunity` | 商机信息 |
| 商机阶段 | `oppProcess` | 商机 pipeline 阶段定义 |
| 跟进 | `visitRecord` | 跟进/拜访记录 |

## CLI 命令设计

### 命令树

```
xsy <command> [options]

认证:
  xsy auth login              交互式输入凭据完成登录
  xsy auth status             查看当前认证状态
  xsy auth logout             清除本地凭据
  xsy auth reset              强制重置凭据（恢复用）

元数据:
  xsy describe <apiKey>       获取对象字段元数据（类型、必填、可操作权限）
  xsy meta ls                 列出所有常用 apiKey 及其中文名

通用 CRUD（可操作任意对象）:
  xsy get <apiKey> <id>       获取单条记录
  xsy create <apiKey>         创建记录（--data 传入 JSON
  xsy update <apiKey> <id>    更新记录（--data 传入部分字段）
  xsy delete <apiKey> <id>    删除记录（需 --yes 确认）
  xsy query "<SQL>"           SQL 查询（select/from/where/order by/limit）

语义别名（便捷操作）:
  xsy account list            客户列表（--page --size --sort --order）
  xsy account search <kw>     客户搜索（like 查询）
  xsy account get <id>        客户详情
  xsy account create          创建客户
  xsy account update <id>     更新客户
  xsy account delete <id>     删除客户

  xsy opportunity list         商机列表
  xsy opportunity search <kw>  商机搜索
  xsy opportunity get <id>     商机详情
  xsy opportunity create       创建商机
  xsy opportunity update <id>  更新商机
  xsy opportunity delete <id>  删除商机

  xsy stage list              商机阶段定义

  xsy visit list              跟进列表
  xsy visit get <id>          跟进详情
  xsy visit create            创建跟进

Agent 发现:
  xsy schema                  列出所有命令
  xsy schema <path>           获取命令 JSON Schema
```

### 全局 Flags

| Flag | 默认值 | 说明 |
|------|--------|------|
| `--format json\|table\|raw` | `json` | 输出格式 |
| `--jq <expr>` | — | 用 jq 表达式过滤 JSON |
| `--fields <f1,f2>` | — | 只输出指定字段 |
| `--verbose, -v` | `false` | 详细输出 |
| `--debug` | `false` | 调试输出 |
| `--yes, -y` | `false` | 跳过确认（危险操作必须） |
| `--dry-run` | `false` | 预览不执行 |
| `--timeout <s>` | `30` | HTTP 超时（秒） |

## 技术架构

### 技术栈

- **Node.js** ≥ 22, **TypeScript** strict mode
- **commander** — CLI 框架
- **axios** — HTTP 客户端
- **zod** — 参数校验 + 类型推导
- **@inquirer/prompts** — 登录交互
- **tsup** — 构建打包

### 项目结构

```
xiaoshouyi-cli/
├── src/
│   ├── index.ts              # 入口
│   ├── cli.ts                # Commander 主程序
│   ├── config.ts             # 常量（URL、apiKey 映射）
│   ├── types/                # TS 类型定义
│   ├── auth/                 # 认证（storage、manager、login）
│   ├── api/                  # HTTP client、错误处理
│   ├── commands/             # 各命令实现
│   ├── services/             # 业务服务层
│   ├── middleware/            # auth-check、confirmation、output
│   └── utils/                # format、sql、validation
├── skill/                    # Qoder Skill 定义
└── tests/
```

### 认证流程

```
xsy auth login
  → 交互式输入 client_id, client_secret, username, password, security_token
  → GET /auc/oauth2/token 获取 access_token
  → 存储至 macOS Keychain（优先）或 ~/.config/xiaoshouyi-cli/（兜底）
  → Token 过期前 1 分钟自动刷新
  → 401 拦截自动重试一次
  → CI 场景支持 XSY_CLIENT_ID / XSY_CLIENT_SECRET 等环境变量
```

### 输出格式

JSON 模式（默认，Agent 友好）：
```json
{ "code": 200, "msg": "操作成功", "result": {...} }
```

Table 模式（人类可读）：
```
| id       | accountName  | phone        |
|----------|--------------|--------------|
| 2048503  | 销售易       | 138xxxx8888  |
```

## 实施计划

### Phase 1: Foundation
- 初始化 npm 项目、TypeScript 配置
- 安装依赖、配置 tsup 构建
- 定义核心类型（ApiResponse, QueryResult, AuthState 等）

### Phase 2: Auth
- 凭据存储抽象（Keychain + FileStorage）
- OAuth2 Password Grant 登录流程
- Token 生命周期管理（刷新、状态、登出）
- auth 命令实现 + auth-check 中间件

### Phase 3: API Layer
- Axios 实例 + auth 拦截器
- 401 自动重试、错误分类
- 响应格式化输出

### Phase 4: 通用 CRUD
- ObjectService（describe / get / create / update / delete / query）
- 通用命令：`xsy query` `xsy describe` `xsy get/create/update/delete`

### Phase 5: 语义别名
- account / opportunity / visit 语义命令
- SQL 查询构建器（list / search）

### Phase 6: CLI 组装
- meta ls、schema 命令
- 主程序 cli.ts 组装所有命令 + 全局 flags
- 危险操作确认机制

### Phase 7: Skill 集成
- SKILL.md（意图路由、产品总览、安全规则）
- references 文档

### Phase 8: 测试
- vitest 单元测试 + 集成测试
