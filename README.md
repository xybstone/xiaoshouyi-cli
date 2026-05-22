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

### 交互式登录

```bash
xsy auth login
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
