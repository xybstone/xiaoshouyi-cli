# xiaoshouyi-cli


销售易 CRM 命令行工具 — 为 AI Agent 设计的 CRM 操作接口。

## OMP MCP 服务

构建：

```bash
npm run build
```

项目提供只读 MCP server：`dist/mcp-server.js`。项目级配置位于 `.omp/mcp.json`，OMP 重载 MCP 后会发现 `xsy-sales`。

工具：

- `sales_order_detail`：按订单号查询订单、报价单和全部报价行，包含 BOM 配置参数；
- `sales_hci_quote_details`：按国内业务事业部、订单金额非负、`isCube__c=true` 查询一体机订单及全部报价行；
- `sales_monthly_summary`：按签约月份汇总一体机销售；
- `sales_standard_pricebook`：查询销售易标准价格表（`priceBookId=3222340301701443`）的产品、规格型号、标准价、单位和状态；
- `sales_order_bom`：按订单号查询报价单全部报价行及 `customItem26__c` / `customItem56__c` BOM 配置参数；
- `sales_order_reconciliation`：按订单号核对 `order.amount`、订单父行 `orderProduct.priceTotal` 和报价行 `quoteLine.amountDomestic`，返回差异与异常标记；
- `sales_crm_field_dictionary`：返回内置 CRM 关键字段字典、对象关系、枚举和分析口径；
- `sales_crm_object_metadata`：按 API Key 返回 CRM 对象完整字段元数据。

CRM 字段资料随项目 skill 保存在 `skill/references/crm/`。标准价格表不是订单销售额。正式销售额使用 `order.amount`；标准价用于硬件/软件价格结构分析，报价单明细用于实际报价和 BOM 分析。订单级金额以核对工具返回的差异和状态为准。

## 功能概览

- **客户管理**：增删改查、列表、搜索
- **商机管理**：增删改查、列表、搜索、阶段定义
- **跟进记录**：列表、详情、创建
- **审批管理**：待办查询、批准、驳回
- **通用 SQL 查询**：任意 CRM 对象的灵活查询
- **元数据发现**：字段定义、对象列表、命令发现

## 安装

```bash
npm install -g xiaoshouyi-cli
```

## 认证

在项目目录创建 `.env`，填入：

```bash
XSY_ACCESS_TOKEN=your_access_token_here
```

或运行：

```bash
xsy auth login
```

## 常用命令

```bash
xsy account list
xsy account search "华为"
xsy opportunity list
xsy query "select id,accountName from account limit 0,10"
xsy describe account
xsy meta ls
xsy schema
```

## 故障排查

| 症状 | 解决 |
|---|---|
| 未登录 | `xsy auth login` |
| Token 刷新失败 | `xsy auth login` |
| CRM Cookie 未配置 | `xsy auth crm-cookie --auto` |

## 许可证

Private

