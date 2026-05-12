# xiaoshouyi-cli

销售易 CRM 命令行工具 — 为 AI Agent 设计的 CRM 操作接口。

## 安装

```bash
npm install -g xiaoshouyi-cli
```

## 快速开始

```bash
# 登录
xsy auth login

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
