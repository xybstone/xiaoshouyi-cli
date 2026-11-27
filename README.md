# xiaoshouyi-cli


销售易 CRM 命令行工具 — 为 AI Agent 设计的 CRM 操作接口。

## 技服工单接入

新增 `xsy ticket`，以 `fieldJob` 为主对象，提供结构化查询、详情、能力、动作计划、私有操作账本及经核验协议的执行适配。CLI/MCP 共用实现，复用现有认证、HTTP 与对象查询。

```bash
npm run typecheck
npm test
npm run build
node scripts/ticket-smoke.mjs
node dist/cli.js ticket capabilities
node dist/cli.js ticket --help
```

创建已内置直连 `POST /rest/data/v2.0/xobjects/fieldJob`，复用现有认证和 prepare/execute；按当前元数据检查必填和枚举，并由创建接口最终校验权限及业务规则。其他生命周期动作仍需真实动作契约，合成闭环测试不代表真实 CRM 流转已验收。未核验动作不会退化为任意主表更新。

2026-11-26 已通过原生 CLI 在当前 CRM 创建一张明确标记的测试工单，并回读验证 ID、标题及待处理状态。该结果验证了本次账号和远程工单类型的创建；其他类型及后续流转分别验收。

2026-11-27 又新建一张测试工单，真实通过专用本人派工、独立CRM活动记录、实时任务发现、提交、受控预处理、节点推进、0.5小时工时、报告补录与结单；时间线读回活动和流程日志。附件上传及文件字节校验已通过，关联因当前OAuth无法独立读取页面doc字段而保持待验证。用户已选择继续仅用OAuth，网页会话限定动作保留未验收，独立服务报告只预检、不生成或发送。见[本轮缺口验收](docs/fieldjob-gap-verification-2026-11-27.md)；前一张测试单记录见[首次实测](docs/fieldjob-live-verification-2026-11-27.md)。

已补齐持续认证、候选引用消歧、编号/时间映射、无回执恢复、人工核对和状态化生命周期测试。执行结果只有回读验证成功才返回退出码 0；明确拒绝为 1、结果不确定为 2、等待回读验证为 3。失败摘要写入 stderr，包含操作号及只读回查命令。

配置、命令、契约格式和 MCP 宿主确认见 [工单使用说明](skill/references/tickets/README.md)；后续人工验证步骤见 [工单开发交接与测试指南](docs/fieldjob-development-handoff.md)。完整本地检查可运行 `npm run check`，该检查只使用假 Token 和合成服务端。

## OMP MCP 服务

构建：

```bash
npm run build
```

项目提供默认不写 CRM 的 MCP server：`dist/mcp-server.js`。项目级配置位于 `.omp/mcp.json`，OMP 重载 MCP 后会发现 `xsy-sales`。全局安装后也可直接用 `xsy-mcp` 作为 MCP server 命令。工单 prepare、回查和下载可能写入本地私有文件；远端执行工具需要显式启用及宿主确认。

工单 MCP 与 CLI 共用 `TicketService`、认证刷新、动作合同和操作账本。默认注册11个工单工具：

- `tickets_search`、`tickets_get`、`tickets_reference_resolve`：检索、详情和关联对象解析；
- `tickets_capabilities`、`tickets_workflow`、`tickets_timeline`：能力、当前流程和时间线；
- `tickets_service_report_preflight`：独立服务报告预检；
- `tickets_prepare`、`tickets_operation_get`：生成计划及查询操作结果；
- `tickets_attachment_download`、`tickets_attachment_download_uploaded`：下载关联附件或核对本人已上传文件。

`tickets_execute` 需要显式启用写入并由可信宿主签名确认；`tickets_operation_review` 需要宿主签名确认人工核对内容，详见[宿主确认协议](skill/references/tickets/README.md#mcp宿主确认)。仅配置密钥不会自动完成客户端的用户确认与签名接入。

`.omp/mcp.json` 只登记服务入口。部署时还需向服务进程配置凭据来源；复用现有隔离登录使用 `XSY_NEOCRM_PROJECT`，已核验的流程、时间线等协议通过 `XSY_TICKET_CONTRACTS` 加载，操作目录通过 `XSY_TICKET_STATE_DIR` 指定。本轮真实 MCP 只读调用及可复现配置见[验收记录](docs/fieldjob-gap-verification-2026-11-27.md#mcp真实只读验收)。

销售 MCP 工具：

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

