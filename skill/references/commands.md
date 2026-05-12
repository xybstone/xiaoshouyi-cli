# xiaoshouyi-cli 命令参考

## 认证命令

```
xsy auth login          交互式输入凭据完成登录
xsy auth status         查看认证状态（JSON）
xsy auth logout         清除本地凭据
xsy auth reset          强制重置凭据（恢复用）
```

## 通用 CRUD 命令

可操作任意 CRM 对象：

```
xsy query "select id,name from account limit 0,10"    SQL 查询
xsy describe account                                   对象字段元数据
xsy get account 2048503                                获取单条记录
xsy create account --data '{"accountName":"新客户"}'    创建记录
xsy update account 2048503 --data '{"phone":"138..."}' 更新记录
xsy delete account 2048503 -y                          删除记录（不可逆，需 --yes）
```

## 客户（account）命令

```
xsy account list [--page 1] [--size 20] [--sort accountName] [--order asc|desc] [--format json|table] [--fields id,name]
xsy account search <keyword> [--fields id,name]
xsy account get <id> [--fields id,name]
xsy account create --data '{"accountName":"...", "phone":"...", ...}'
xsy account update <id> --data '{"phone":"...", ...}'
xsy account delete <id> -y
```

客户 list 默认字段：id, accountName, phone, industry, createdAt

## 商机（opportunity）命令

```
xsy opportunity list [--page 1] [--size 20] [--format json|table]
xsy opportunity search <keyword>
xsy opportunity get <id>
xsy opportunity create --data '{"opportunityName":"...", "customerId":"...", ...}'
xsy opportunity update <id> --data '{...}'
xsy opportunity delete <id> -y
xsy opportunity stages                                  商机阶段定义列表
```

商机 list 默认字段：id, opportunityName, customerId, stage, money, createdAt

## 跟进（visitRecord）命令

```
xsy visit list [--page 1] [--size 20] [--format json|table]
xsy visit get <id>
xsy visit create --data '{"content":"...", "visitDate":"...", "customerId":"...", ...}'
```

跟进 list 默认字段：id, content, visitDate, customerId, creator

## 元数据 / Agent 发现

```
xsy meta ls             列出所有 apiKey 及中文名（JSON）
xsy schema              列出所有命令树（JSON，供 Agent 发现）
xsy schema <path>       命令路径 schema（预留）
```

## 全局选项

| 选项 | 默认值 | 说明 |
|------|--------|------|
| `--format <fmt>` | json | 输出格式：json / table / raw |
| `--fields <f1,f2>` | — | 只输出指定字段（逗号分隔） |
| `-v, --verbose` | false | 详细输出 |
| `--debug` | false | 调试输出 |
| `-y, --yes` | false | 跳过删除确认（危险操作） |
| `--timeout <s>` | 30 | HTTP 超时（秒） |

## 环境变量

| 变量 | 说明 |
|------|------|
| `XSY_CLIENT_ID` | OAuth2 client_id |
| `XSY_CLIENT_SECRET` | OAuth2 client_secret |
| `XSY_USERNAME` | 用户名 |
| `XSY_PASSWORD` | 密码（不含安全令牌） |
| `XSY_SECURITY_TOKEN` | 8位安全令牌 |
| `XSY_ACCESS_TOKEN` | 直接注入 token，跳过 OAuth |
| `XSY_API_BASE_URL` | API 地址（多租户） |
