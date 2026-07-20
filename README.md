# xiaoshouyi-cli

销售易 CRM 命令行工具 — 为 AI Agent 设计的 CRM 操作接口。

## 功能概览

- **客户管理**：增删改查、列表、搜索
- **商机管理**：增删改查、列表、搜索、阶段定义
- **跟进记录**：列表、详情、创建
- **审批管理**：待办查询、批准、驳回
- **通用 SQL 查询**：任意 CRM 对象的灵活查询
- **元数据发现**：字段定义、对象列表、命令发现
- **Cookie 自动刷新**：跟进记录和审批操作自动维护会话

## 安装

```bash
npm install -g xiaoshouyi-cli
```

## 认证

### 免登录（推荐）

在项目目录创建 `.env` 文件，填入 access token 即可跳过登录：

```bash
# .env
XSY_ACCESS_TOKEN=your_access_token_here
```

之后所有命令自动读取，无需 `xsy auth login`。

**如何获取 access token：**

1. 登录销售易 CRM 网页端
2. 进入 **客户管理** → **安全令牌**
3. 点击 **获取安全令牌** 按钮
4. 将获取到的 token 填入 `.env` 文件

### 用户名密码登录

```bash
xsy auth login
```

交互式输入以下 5 项信息：

| 字段 | 说明 |
|------|------|
| Client ID | 应用标识 |
| Client Secret | 应用密钥 |
| Username | 登录用户名 |
| Password | 登录密码 |
| Security Token | 安全令牌（8 位数字） |

> Security Token 与上述 Access Token 不同，在 **客户管理 → 安全令牌** 页面获取。

**非交互式登录（CI/自动化）：**

```bash
# .env
XSY_CLIENT_ID=xxx
XSY_CLIENT_SECRET=xxx
XSY_USERNAME=xxx
XSY_PASSWORD=xxx
XSY_SECURITY_TOKEN=xxxxxx  # 8位安全令牌
```

### CRM Cookie 配置

跟进记录和审批操作需要 CRM 域 Cookie。有两种方式：

#### 方式一：自动获取（推荐）
```bash
xsy auth crm-cookie --auto
```
使用已保存的凭据自动登录 CRM 获取 Cookie。Cookie 过期时也会自动尝试刷新。

#### 方式二：从浏览器手动复制
1. 登录销售易 CRM 网页端
2. F12 → Network → 刷新页面
3. 点击任意请求，复制 Cookie 请求头

```bash
xsy auth crm-cookie --cookie 'JSESSIONID=xxx; ...'
```

清除 Cookie：
```bash
xsy auth crm-cookie --clear
```

## 常用命令

### 客户
```bash
xsy account list                          # 客户列表
xsy account search "华为"                 # 搜索客户
xsy account get 2048503                   # 客户详情
xsy account create --data '{"accountName":"新客户"}'  # 创建客户
xsy account update 2048503 --data '{"phone":"123"}'   # 更新客户
xsy account delete 2048503 -y            # 删除客户
xsy account follows 2048503              # 跟进记录
```

### 商机
```bash
xsy opportunity list                      # 商机列表
xsy opportunity search "云服务"           # 搜索商机
xsy opportunity get 123                   # 商机详情
xsy opportunity stages                    # 阶段定义
xsy opportunity follows 123               # 跟进记录
```

### 跟进
```bash
xsy visit list <itemId>                   # 跟进列表
xsy visit get <id>                        # 跟进详情
xsy visit create --data '{...}'           # 创建跟进
```

### 审批
```bash
xsy approval list                         # 待审批列表
xsy approval get <id>                     # 审批详情
xsy approval approve <id> --comment "同意" # 批准
xsy approval reject <id> --comment "理由"  # 驳回
xsy approval refresh-cookie               # 手动刷新 Cookie
```

### 通用
```bash
xsy query "select id,accountName from account limit 0,10"  # SQL 查询
xsy describe account                      # 对象字段定义
xsy meta ls                               # 列出所有对象
xsy schema                                # 命令发现
```

### 输出格式

所有命令默认 JSON 输出，Agent 友好：

```bash
xsy account list                          # JSON（默认）
xsy account list --format table           # 表格
xsy account list --format table --fields id,accountName  # 指定字段
```

## 故障排查

| 症状 | 原因 | 解决 |
|------|------|------|
| 未登录 | token 过期 | `xsy auth login` |
| Token 刷新失败 | 凭据失效 | `xsy auth login` 重新登录 |
| CRM Cookie 未配置 | 跟进/审批需要 Cookie | `xsy auth crm-cookie --auto` |
| Cookie 过期 | 会话超时 | 自动刷新或 `xsy auth crm-cookie --auto` |
| 审批查询失败 | Cookie 过期 | `xsy approval refresh-cookie` |

## 许可证

Private
