# xiaoshouyi-cli Skill

## 产品总览

`xiaoshouyi-cli` 是销售易 CRM 的命令行工具，面向 AI Agent 设计，提供统一的 CRM 数据操作接口。

通过标准的 CLI 命令，Agent 可以完成：
- 客户（account）的增删改查、列表、搜索
- 商机（opportunity）的增删改查、列表、搜索
- 商机阶段（oppProcess）定义查看
- 跟进记录（visitRecord）的列表、详情、创建
- **审批管理**（approval）：待办查询、批准、驳回
- 任意 CRM 对象的通用 SQL 查询和 CRUD 操作
- Cookie 自动过期刷新（跟进记录和审批操作会话自动维护）

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

**如何获取安全令牌：**

1. 登录 ZStack 销售易 CRM 网页端
2. 在左侧导航栏进入 **客户管理** → **安全令牌**
3. 点击 **获取安全令牌** 按钮即可生成 token
4. 将获取到的 token 填入 `.env` 文件中的 `XSY_ACCESS_TOKEN`

### 用户名密码登录

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

> **Security Token 获取方式：** 登录 CRM 网页端 → **客户管理** → **安全令牌** → 页面会显示一个 8 位数字的安全令牌。注意此处的 Security Token 和上一节的 Access Token 是不同的字段。

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

**跟进功能需要额外配置 CRM Cookie**（REST API 域的 activityRecord 对象被禁用）。有两种方式：

### 方式一：自动获取（推荐）
```bash
# 使用已保存的凭据自动登录 CRM 获取 Cookie
xsy auth crm-cookie --auto
# 或
xsy approval refresh-cookie
```

### 方式二：从浏览器手动复制
登录销售易 CRM 网页端，打开浏览器开发者工具（F12）→ **Network** 标签页 → 刷新页面或触发任一操作 → 点击任意网络请求，找到 **Cookie** 请求头，复制完整的 Cookie 值。

```bash
# 手动设置 Cookie
xsy auth crm-cookie --cookie 'JSESSIONID=xxx; ...'

# 也可通过环境变量保存
XSY_CRM_COOKIE='JSESSIONID=xxx; ...' xsy auth crm-cookie

# 清除过期 Cookie
xsy auth crm-cookie --clear
```

> **Cookie 自动刷新**：`fetchActivityRecords` 在检测到 Cookie 过期时会自动尝试使用存储的凭据重新登录，无需手动干预。

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
| 审批待办列表 | `xsy approval list --status 0` | 0-待审批,1-已通过,2-已驳回 |
| 审批详情 | `xsy approval get <id>` | — |
| 批准审批 | `xsy approval approve <id> --comment "同意"` | — |
| 驳回审批 | `xsy approval reject <id> --comment "理由"` | — |
| 自动刷新 CRM Cookie | `xsy auth crm-cookie --auto` | 需先登录保存凭据 |

### 路由决策树

1. **需要登录？** → `xsy auth login`
2. **操作具体客户？** → `xsy account <subcommand>`
3. **操作具体商机？** → `xsy opportunity <subcommand>`
4. **查看某客户或商机的跟进？** → `xsy account follows <id>` 或 `xsy opportunity follows <id>`
5. **审批相关？（待办/审批/驳回）** → `xsy approval list|approve|reject <id>`
6. **复杂查询/跨对象？** → `xsy query "<SQL>"`
7. **查看字段定义？** → `xsy describe <apiKey>`
8. **不知道有什么命令？** → `xsy schema`
9. **不知道有什么对象？** → `xsy meta ls`

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

## 实际合同与超融合一体机统计

当用户要统计实际订单、合同金额、区域或一体机销售情况时，**不要只查询 `opportunity`**。销售易中的实际成交数据应以订单及订单明细为主，按以下关系取数：

```text
order → orderProduct → product
  ├── account       客户
  └── opportunity   关联商机
```

### 推荐识别规则

1. 优先查询 `order`，用订单号 `po` 定位实际订单。
2. 用 `order.isCube__c = 1` 识别一体机订单。
3. 同时检查 `order.customItem224__c`（合同/订单描述）是否包含“一体机”“超融合”。
4. 查询 `orderProduct` 明细，通过 `productId` 关联 `product.productName`；产品名称包含“一体机”或“超融合”时纳入产品明细统计。
5. `opportunity` 只用于补充项目背景、商机阶段、项目所在地和预测信息，不能替代实际订单金额。

### 订单统计字段

| 统计内容 | 对象.字段 |
|----------|-----------|
| 实际订单金额 | `order.amount` |
| 原始订单金额 | `order.initAmount` |
| 订单号/采购订单号 | `order.po` |
| 订单创建时间 | `order.createdAt` |
| 合同签订日期 | `order.signDate__c` |
| 客户 | `order.accountId` → `account` |
| 订单描述 | `order.customItem224__c` |
| 是否一体机 | `order.isCube__c` |
| 产品行数 | `order.lineItemCount` |
| 产品总数量 | `order.productsAmount` |
| 事业部 | `order.customItem428__c` |
| 销售部 | `order.customItem429__c` |
| 销售区域 | `order.customItem430__c` |
| 管理省份 | `order.customItem445__c` |
| 明细产品 | `orderProduct.productId` → `product.productName` |
| 明细数量 | `orderProduct.quantity` |
| 明细单价 | `orderProduct.unitPrice` |

### 报价单价格明细

如果用户需要实际报价价格，不能只使用 `orderProduct.unitPrice`。订单通过报价单关联到报价单明细：

```text
order.orderRelQuotationEntity → quote.id
quote.name                  → 报价单编号
orderProduct.customItem250__c → quoteLine.id
orderProduct.customItem257__c → 报价单编号
quoteLine.quotationDetailEntityRelQuotationEntity → quote.id
```

报价明细的主要价格字段：

| 统计内容 | 对象.字段 |
|----------|-----------|
| 报价单编号 | `quote.name` |
| 报价单总金额 | `quote.quotationAmountDomestic` |
| 报价单原价合计 | `quote.listTotalDomestic` |
| 报价总折扣 | `quote.totalDiscountAmountDomestic` |
| 报价明细产品 | `quoteLine.quotationDetailEntityRelProduct` → `product` |
| 报价明细规格型号 | `quoteLine.customItem1__c` |
| 报价明细数量 | `quoteLine.quantity` |
| 实际报价单价 | `quoteLine.priceDomestic` |
| 实际报价金额 | `quoteLine.amountDomestic` |
| 报价汇总单价 | `quoteLine.aggregatedPriceDomestic` |
| 报价汇总金额 | `quoteLine.aggregatedAmountDomestic` |
| 报价标准价 | `quoteLine.customItem21__c` |
| 报价计量单位 | `quoteLine.customItem5__c` |

查询示例：

```bash
xsy query "select id,orderRelQuotationEntity from order where po = '订单号' limit 0,1"
xsy query "select id,name,quotationAmountDomestic,listTotalDomestic,totalDiscountAmountDomestic from quote where id = 报价单ID limit 0,1"
xsy query "select id,quotationDetailEntityRelProduct,quantity,priceDomestic,amountDomestic,aggregatedPriceDomestic,aggregatedAmountDomestic,customItem1__c,customItem5__c,customItem21__c from quoteLine where quotationDetailEntityRelQuotationEntity = 报价单ID limit 0,100"
```

`quoteLine.priceDomestic` 为报价明细实际报价价；`customItem21__c` 为标准价，不能用标准价替代实际报价价。价格分析应先拉取每个订单关联报价单的全部 `quoteLine`，再将零价行作为异常/待核实子集筛选；不能一开始只拉取 `priceDomestic = 0 AND standardPrice > 0` 的行。

报价明细中的 BOM/配置参数字段为 `quoteLine.customItem26__c`（配置参数（拼接）），完整配置说明也可取 `quoteLine.customItem56__c`（配置参数）。`quoteLine.customItem57__c` 是是否组合产品，`quoteLine.customItem55__c` 是 BOM 类型。对一体机硬件报价行，配置参数可能包含 CPU、内存、SSD、硬盘、阵列卡、网卡、电源、导轨、维保和软件授权；因此硬件与软件占比应优先从该字段解析，而不是只看产品名称。

示例配置：`CPU *2/480G SSD*2/SAS卡*1/双口千兆*1+双口万兆带模块*1/电源*2/导轨/三年维保`。解析时保留原文，按标签分为硬件组件、服务/维保、软件授权三类；没有独立组件价格时，只能按报价行金额归属，不能把整机金额无依据拆分到各组件。

标准价格表对象为 `priceBook`，标准价格表 ID 为 `3222340301701443`；价格表明细对象为 `priceBookEntry`。标准价字段包括 `productPrice`、`bookPrice`、`fscProductModel`、`fscProductSpec`、`customItem23__c`。它们可提供“机头/配件/软件产品”的标准价参考，但不是订单实际销售额，也不能替代 BOM 配置参数。

报价行的 BOM 配置字段和标准价格表必须结合使用：`quoteLine.customItem26__c` / `customItem56__c` 解释整机包含的硬件、软件和服务；`priceBookEntry` 解释产品标准价。若整机报价行只有一个总价，没有独立组件报价行，禁止按标准价比例擅自拆分整机金额。

## 标准查询流程

按订单号查询：

```bash
xsy query "select id,po,accountId,amount,initAmount,productsAmount,lineItemCount,createdAt,signDate__c,customItem224__c,isCube__c,customItem428__c,customItem429__c,customItem430__c,customItem445__c from order where po = '订单号' limit 0,1"
```

按订单 ID 查询产品明细：

```bash
xsy query "select id,orderId,productId,quantity,unitPrice from orderProduct where orderId = 订单ID limit 0,100"
```

按产品 ID 补充产品名称：

```bash
xsy query "select id,productName from product where id in ('产品ID1','产品ID2') limit 0,100"
```

补充客户和商机：

```bash
xsy account get 客户ID
xsy opportunity get 商机ID
```

### 日期和金额口径

- 日期筛选优先使用毫秒时间戳；该租户对日期字符串条件可能返回“内部服务错误”。
- “3 月至 9 月 30 日”应明确年份，并转换为 `[当年-03-01 00:00:00, 当年-09-30 23:59:59]` 的毫秒时间戳。
- 实际合同销售额使用 `order.amount`，不要使用 `opportunity.money`；后者是商机金额，可能与最终订单金额不同。
- 产品数量使用 `orderProduct.quantity` 分产品汇总；不要仅使用 `order.productsAmount`，因为它是所有明细数量的合计，且可能包含软件、免费项或扩容组件。
- `quantity × unitPrice` 仅用于明细校验。折扣、免费项、附加费用会导致其与 `order.amount` 不一致，正式销售额以订单金额为准。
- 订单的销售管理区域和项目所在地可能不同，必须分列：例如 `customItem430__c` 是销售区域，关联商机的项目省份字段可能是另一套口径。

### 订单样例核验方法

对于订单 `JJSH20260929-005`，应得到：

- 订单金额：`1,238,789`
- 客户：北方魏家峁煤电有限责任公司
- `isCube__c = 1`
- 合同描述包含“3台 Cube”和“超融合一体机扩容”
- 销售区域：北区；管理省份：北京
- 订单明细包含 `ZStack Cube超融合一体机` 和 `ZStack AI智算超融合一体机管理软件V1.0`

该样例中合同描述的“3台 Cube”和订单明细拆分数量可能不一致。遇到此情况必须保留原始字段、列出明细，并标记为待业务确认，不能自行修正数量。

### 统计输出建议

最终结果至少包含：订单号、订单日期、客户、订单金额、产品名称、产品数量、是否一体机、销售区域、管理省份、事业部、销售部、关联商机和数据异常说明。统计前先输出少量样例核验关键词和字段，再进行全量分页；每次查询最多 100 条，使用 `limit offset,size` 分页。

## CRM 字段学习资料与分析映射

完整资料位于 `skill/references/crm/`：

- `crm-field-metadata-full.json`：9 个核心对象的完整 describe 元数据；
- `crm-key-field-dictionary.json`：金额、价格、订单、产品、BOM、区域、成本、确收关键字段；
- `crm-enums-and-relations.json`：枚举、关联对象和可选值；
- `CRM字段字典与分析映射.md`：完整对象关系、字段语义和限制。

核心关系：

```text
order.accountId → account.id
order.opportunityId → opportunity.id
order.orderRelQuotationEntity → quote.id
orderProduct.orderId → order.id
orderProduct.productId → product.id
orderProduct.customItem250__c → quoteLine.id
orderProduct.customItem257__c → quote.name
quoteLine.quotationDetailEntityRelQuotationEntity → quote.id
quoteLine.quotationDetailEntityRelProduct → product.id
priceBookEntry.priceBookId → priceBook.id
priceBookEntry.productId → product.id
```

字段规则：

- 批量销售规模使用 `order.amount`；
- 订单父行核对使用 `sum(orderProduct.priceTotal)`；
- 实际报价使用 `quoteLine.priceDomestic` / `amountDomestic`；
- `aggregatedPriceDomestic` / `aggregatedAmountDomestic` 是配置估值，不是成交收入；
- `priceBookEntry.productPrice` / `bookPrice` 是标准价，不替代合同金额或确收金额；
- BOM 使用 `quoteLine.customItem26__c` / `customItem56__c`，BOM 类型使用 `customItem55__c`，组合产品使用 `customItem57__c`；
- 父行和子行不能同时计入收入或成本；无独立组件价格时，不得按标准价比例拆分整机金额；
- `priceDomestic=0` 通常是打包/配置行，不能直接认定为免费或缺价。

分析字段：

- 销售区域：`order.customItem430__c`；
- 管理省份：`order.customItem445__c`；
- 事业部：`order.customItem428__c`；
- 销售部：`order.customItem429__c`。

主战场、信创、存储和全闪分析必须保留证据文本及 `review` 状态。主战场自动排除规则只能生成候选，不得替代业务确认；管理省份不自动等于最终用户所在地；确收和官方毛利应使用确收明细与官方成本口径。
## 故障排查

| 症状 | 原因 | 解决 |
|------|------|------|
| `未登录` | token 过期且无存储凭据可自动刷新 | `xsy auth login`（首次使用或凭据已清除） |
| `Token 刷新失败` | refresh_token 和存储凭据均失效 | `xsy auth login` 重新登录 |
| `code !== 200` | 业务错误 | 检查 `msg` 字段 |
| `--data 格式无效` | JSON 语法错误 | 检查引号转义 |
| `CRM Cookie 未配置` | 跟进功能未设置 Cookie | `xsy auth crm-cookie --cookie '...'` 或 `xsy auth crm-cookie --auto` |
| 跟进返回空 | Cookie 过期 | 自动刷新: `xsy auth crm-cookie --auto` 或 `xsy approval refresh-cookie` |
| 审批待办列表 | 查询审批 | `xsy approval list` |
| 审批详情 | 查看审批 | `xsy approval get <id>` |
| 批准审批 | 通过审批 | `xsy approval approve <id> --comment "同意"` |
| 驳回审批 | 拒绝审批 | `xsy approval reject <id> --comment "驳回理由"` |
