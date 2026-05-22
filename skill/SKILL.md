# xiaoshouyi-cli Skill

## 产品总览

`xiaoshouyi-cli` 是销售易 CRM 的命令行工具，面向 AI Agent 设计，提供统一的 CRM 数据操作接口。

通过标准的 CLI 命令，Agent 可以完成：
- 客户（account）的增删改查、列表、搜索
- 商机（opportunity）的增删改查、列表、搜索
- 商机阶段（oppProcess）定义查看
- 跟进记录（visitRecord）的列表、详情、创建
- 任意 CRM 对象的通用 SQL 查询和 CRUD 操作

## 安装

```bash
npm install -g xiaoshouyi-cli
```

## 认证（必须先执行）

### 免登录（推荐）

在项目目录创建 `.env` 文件，填入 `XSY_ACCESS_TOKEN` 即可跳过登录，CLI 启动时自动加载：

```bash
# .env
XSY_ACCESS_TOKEN=your_access_token_here
```

> `.env` 中的变量不会覆盖 shell 中已 export 的同名环境变量。

### 交互式登录

```bash
xsy auth login
```

### 环境变量 / .env 直通（CI / 自动化）

可在 `.env` 或 shell 环境变量中配置凭据，使 `xsy auth login` 非交互式完成：

```bash
XSY_CLIENT_ID=xxx
XSY_CLIENT_SECRET=xxx
XSY_USERNAME=xxx
XSY_PASSWORD=xxx
XSY_SECURITY_TOKEN=xxxxxx  # 8位安全令牌
xsy auth login
```

> 交互式登录时 password 输入 = 用户密码 + 8位安全令牌（直接拼接）；环境变量方式则分别传入 XSY_PASSWORD 和 XSY_SECURITY_TOKEN

**跟进功能需要额外配置 CRM Cookie**（REST API 域的 activityRecord 对象被禁用）：
```bash
# 浏览器 F12 → Network → 复制 Cookie → 保存
xsy auth crm-cookie --cookie '...'
```

## 意图路由

| 用户意图 | 命令 | 示例 |
|----------|------|------|
| 登录/认证 | `xsy auth login` | — |
| 查客户列表 | `xsy account list --page 1 --size 20` | — |
| 搜索客户 | `xsy account search "华为"` | — |
| 查客户详情 | `xsy account get 2048503` | — |
| 创建客户 | `xsy account create --data '{...}'` | — |
| 更新客户 | `xsy account update 2048503 --data '{...}'` | — |
| 删除客户 | `xsy account delete 2048503 -y` | 需 --yes 确认 |
| 查商机列表 | `xsy opportunity list` | — |
| 搜索商机 | `xsy opportunity search "云服务"` | — |
| 商机阶段定义 | `xsy opportunity stages` | — |
| 查客户跟进 | `xsy account follows 2048503` | 需要 CRM Cookie |
| 查商机跟进 | `xsy opportunity follows <id>` | 需要 CRM Cookie |
| 创建跟进 | `xsy visit create --data '{...}'` | — |
| SQL 查询 | `xsy query "select id,accountName from account limit 0,10"` | — |
| 对象元数据 | `xsy describe account` | 字段类型/必填 |
| API Key 列表 | `xsy meta ls` | — |
| 命令发现 | `xsy schema` | JSON格式 |

### 路由决策树

1. **需要登录？** → `xsy auth login`
2. **操作具体客户？** → `xsy account <subcommand>`
3. **操作具体商机？** → `xsy opportunity <subcommand>`
4. **查看某客户或商机的跟进？** → `xsy account follows <id>` 或 `xsy opportunity follows <id>`
5. **复杂查询/跨对象？** → `xsy query "<SQL>"`
6. **查看字段定义？** → `xsy describe <apiKey>`
7. **不知道有什么命令？** → `xsy schema`
8. **不知道有什么对象？** → `xsy meta ls`

## 输出格式

所有命令输出 JSON（默认），Agent 友好：

```json
// 成功
{"code":200,"result":{...}}

// 失败
{"status":"error","message":"错误描述"}
```

人类可读表格：
```bash
xsy account list --format table
xsy account list --format table --fields id,accountName
```

## 安全规则（必须遵守）

### 禁止操作

- **禁止删除客户/商机时不加 `-y`**：删除前必须向用户确认，然后在命令中加入 `-y` 标志
- **禁止在未认证时执行数据操作**：所有 CRUD 命令需要先登录
- **禁止在 --data 中传入非 JSON 内容**

### 必须操作

- **首次使用必须先认证**：执行 `xsy auth login` 后方可操作数据
- **删除操作必须加 `-y`**：`xsy account delete <id> -y`
- **敏感操作后验证**：删除后执行 `xsy account get <id>` 确认已删除

### SQL 查询限制

- select 不支持 `*`，必须列出具体字段
- like 仅支持后缀通配: `field like 'value%'`
- order by 因对象而异（account list 支持 id/accountName/createdAt 白名单），通用 query 命令无此限制
- 每次查询限制 100 条，分页使用 `limit offset,size`

### 环境变量安全

- **推荐使用 `.env` 文件存储 token**：`XSY_ACCESS_TOKEN=<token>` 写入项目根目录 `.env`，CLI 自动加载
- 生产环境建议使用环境变量传入凭据，避免在命令行暴露
- `XSY_CLIENT_SECRET`、`XSY_PASSWORD` 和 `XSY_CRM_COOKIE` 不应记录到日志
- CRM Cookie 是浏览器会话凭证，泄露等同于账号泄露

## 故障排查

| 症状 | 原因 | 解决 |
|------|------|------|
| `未登录` | token 过期且无存储凭据可自动刷新 | `xsy auth login`（首次使用或凭据已清除） |
| `Token 刷新失败` | refresh_token 和存储凭据均失效 | `xsy auth login` 重新登录 |
| `code !== 200` | 业务错误 | 检查 `msg` 字段 |
| `--data 格式无效` | JSON 语法错误 | 检查引号转义 |
| `CRM Cookie 未配置` | 跟进功能未设置 Cookie | `xsy auth crm-cookie --cookie '...'` |
| 跟进返回空 | Cookie 过期 | 浏览器重新复制 Cookie 后更新 |
