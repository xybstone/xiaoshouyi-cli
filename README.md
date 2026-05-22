# xiaoshouyi-cli

销售易 CRM 命令行工具 — 为 AI Agent 设计的 CRM 操作接口。

## 安装

```bash
npm install -g xiaoshouyi-cli
```

## 快速开始

### 免登录（推荐）

在项目目录创建 `.env` 文件，填入 access token 即可跳过登录：

```bash
# .env
XSY_ACCESS_TOKEN=your_access_token_here
```

之后所有命令自动读取，无需 `xsy auth login`。也支持在 `.env` 中配置登录凭据，使 `xsy auth login` 非交互式完成。

**如何获取安全令牌：**

1. 登录 ZStack 销售易 CRM 网页端
2. 在左侧导航栏进入 **客户管理** → **安全令牌**
3. 点击 **获取安全令牌** 按钮即可生成 token
4. 将获取到的 token 填入 `.env` 文件中的 `XSY_ACCESS_TOKEN`

### CRM Cookie 配置

部分操作（如查看客户/商机的跟进记录）需要 CRM 域 Cookie，可通过浏览器获取：

1. 登录销售易 CRM 网页端
2. 打开浏览器开发者工具（F12）
3. 切换到 **Network**（网络）标签页
4. 刷新页面或触发任一操作
5. 点击任意网络请求，找到 **Cookie** 请求头
6. 复制完整的 Cookie 值

保存方式：

```bash
# 方式一：通过命令行传入
xsy auth crm-cookie --cookie 'JSESSIONID=xxx; ...'

# 方式二：通过环境变量（也支持写入 .env 文件）
XSY_CRM_COOKIE='JSESSIONID=xxx; ...' xsy auth crm-cookie
```

清除 Cookie：

```bash
xsy auth crm-cookie --clear
```

### 用户名密码登录

如果不想使用安全令牌，也可以用销售易账号密码登录：

```bash
xsy auth login
```

交互式输入以下 5 项信息：

| 字段 | 说明 |
|------|------|
| Client ID | 应用标识 |
| Client Secret | 应用密钥 |
| Username | 登录用户名（手机号/邮箱） |
| Password | 登录密码 |
| Security Token | 安全令牌（8 位数字，与安全令牌页获取的 Access Token 不同） |

> **Security Token 获取方式：** 登录 CRM 网页端 → **客户管理** → **安全令牌** → 页面会显示一个 8 位数字的安全令牌。注意此处的 Security Token 和上一节提到的 Access Token 是不同的字段。

**非交互式登录：** 在 `.env` 中配置以下环境变量，`xsy auth login` 会自动读取并跳过交互提示：

```bash
# .env
XSY_CLIENT_ID=your_client_id
XSY_CLIENT_SECRET=your_client_secret
XSY_USERNAME=your_username
XSY_PASSWORD=your_password
XSY_SECURITY_TOKEN=your_8_digit_security_token
```

### 常用命令

```bash
# 查看客户列表
xsy account list

# SQL 查询
xsy query "select id,accountName from account limit 0,10"

# 获取对象元数据
xsy describe account

# 查看所有命令
xsy schema
```

## 许可证

Private
