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

```bash
# 交互式登录
xsy auth login

# 查看状态
xsy auth status

# 环境变量直通（CI）
export XSY_CLIENT_ID=xxx
export XSY_CLIENT_SECRET=xxx
export XSY_USERNAME=xxx
export XSY_PASSWORD=xxx
export XSY_SECURITY_TOKEN=xxxxxx  # 8位安全令牌
xsy auth login
```

> password = 用户密码 + 8位安全令牌（直接拼接，无分隔符）

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
| 跟进列表 | `xsy visit list` | — |
| 创建跟进 | `xsy visit create --data '{...}'` | — |
| SQL 查询 | `xsy query "select id,accountName from account limit 0,10"` | — |
| 对象元数据 | `xsy describe account` | 字段类型/必填 |
| API Key 列表 | `xsy meta ls` | — |
| 命令发现 | `xsy schema` | JSON格式 |

### 路由决策树

1. **需要登录？** → `xsy auth login`
2. **操作具体客户？** → `xsy account <subcommand>`
3. **操作具体商机？** → `xsy opportunity <subcommand>`
4. **查看/创建跟进？** → `xsy visit <subcommand>`
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
- order by 仅支持 `id` 字段
- 每次查询限制 100 条，分页使用 `limit offset,size`

### 环境变量安全

- 生产环境建议使用环境变量传入凭据，避免在命令行暴露
- `XSY_CLIENT_SECRET` 和 `XSY_PASSWORD` 不应记录到日志

## 故障排查

| 症状 | 原因 | 解决 |
|------|------|------|
| `未登录` | token 过期或未认证 | `xsy auth login` |
| `Token 刷新失败` | refresh_token 过期 | `xsy auth login` 重新登录 |
| `code !== 200` | 业务错误 | 检查 `msg` 字段 |
| `--data 格式无效` | JSON 语法错误 | 检查引号转义 |
