# CRM 字段字典与分析映射

## 学习范围

已通过销售易 describe API 读取完整元数据：

| 对象 | 中文名 | 字段数 |
|---|---|---:|
| `order` | 订单 | 352 |
| `orderProduct` | 订单明细 | 147 |
| `quote` | 报价单 | 119 |
| `quoteLine` | 报价单明细 | 140 |
| `product` | 产品 | 134 |
| `priceBook` | 价格表 | 19 |
| `priceBookEntry` | 价格表明细 | 47 |
| `account` | 客户 | 268 |
| `opportunity` | 销售机会 | 250 |

完整原始元数据：`crm-field-metadata-full.json`。
关键字段字典：`crm-key-field-dictionary.json`。
枚举和关联字段：`crm-enums-and-relations.json`。

## 核心关系

```text
order.accountId → account.id
order.opportunityId → opportunity.id
order.orderRelQuotationEntity → quote.id
orderProduct.orderId → order.id
orderProduct.productId → product.id
orderProduct.customItem250__c → quoteLine.id
orderProduct.customItem257__c → quote.name（报价单编号）
quoteLine.quotationDetailEntityRelQuotationEntity → quote.id
quoteLine.quotationDetailEntityRelProduct → product.id
priceBookEntry.priceBookId → priceBook.id
priceBookEntry.productId → product.id
```

## 订单 order

### 销售规模

| 字段 | 中文标签 | 类型 | 当前用途 |
|---|---|---|---|
| `id` | 记录 ID | Long | 去重主键 |
| `po` | 采购订单号/订单号 | String | 业务定位 |
| `signDate__c` | 签约日期 | Date/Datetime | 财年和月份 |
| `amount` | 订单金额 | Currency | 批量销售额候选权威字段 |
| `initAmount` | 初始金额 | Currency | 变更对照 |
| `productsAmount` | 产品总数量 | Number | 仅作总量参考，不当服务器台数 |
| `lineItemCount` | 明细行数 | Number | 行数参考 |
| `isCube__c` | 是否一体机 | Boolean | 一体机筛选 |
| `customItem224__c` | 合同/订单描述 | Text | 项目文本辅助识别 |

### 组织和地域

| 字段 | 中文标签 | 当前用途 |
|---|---|---|
| `customItem428__c` | 事业部 | 国内业务事业部筛选 |
| `customItem429__c` | 销售部 | 销售组织 |
| `customItem430__c` | 销售区域 | 东区/北区/西区/中南区等 |
| `customItem445__c` | 管理省份 | 省份维度，不直接等于最终用户所在地 |
| `accountId` | 客户 | 关联客户 |
| `opportunityId` | 商机 | 关联项目背景 |
| `orderRelQuotationEntity` | 关联报价单 | 报价关系 |

### 状态/金额核对字段

| 字段 | 用途限制 |
|---|---|
| `poStatus` | 原始状态值；没有业务映射前不擅自解释 |
| `approvalStatus` | 审批状态值；不能当确收状态 |
| `cancelReason` | 取消/作废原因辅助字段 |
| `amount` vs `sum(orderProduct.priceTotal)` | 订单主表与父行核对 |

## 订单明细 orderProduct

| 字段 | 中文标签/用途 |
|---|---|
| `orderId` | 所属订单 |
| `productId` | 产品 |
| `quantity` | 明细数量 |
| `priceTotal` | 明细总金额，订单父行/计价行核对 |
| `unitPrice` | 销售单价（弃用），只作辅助 |
| `customItem186__c` | 单价 |
| `customItem190__c` | 不含税金额 |
| `customItem193__c` | 规格/型号 join 字段 |
| `customItem215__c` | 规格型号文本 |
| `customItem208__c` | 成本单价 |
| `customItem212__c` | 毛利率相关字段，需逐值核验 |
| `customItem250__c` | 报价单明细关联 |
| `customItem257__c` | 报价单编号公式字段 |
| `priceBookEntryId` | 价格表明细 |
| `priceId` | 价格表 |
| `parentLine` | 上级明细，需通过 describe 确认实际字段名和取值 |
| `rootLine` | 顶级明细/根明细 |
| `optionLevel` | 明细层级 |
| `aggregate` | 汇总计算标记 |
| `aggregateToParent` | 是否参与父级汇总 |

订单金额规则：父行和子行不可同时计入；零价配置不等于缺失；服务器数量优先取有效计价硬件父行数量。

## 报价单 quote

| 字段 | 中文标签/用途 |
|---|---|
| `id` | 报价单 ID |
| `name` | 报价单编号 |
| `quotationTitle` | 报价单名称 |
| `quotationAmountDomestic` | 报价单总金额本币 |
| `listTotalDomestic` | 本币原价合计 |
| `totalDiscountAmountDomestic` | 本币总折扣 |
| `quotationQuantity` | 总数量 |
| `priceListId` | 价格表 |
| `quotationEntityRelAccount` | 最终用户 |
| `quotationEntityRelOpportunity` | 商机 |
| `customItem67__c` | 是否转订单 |
| `customItem59__c` | 一体机数量 |

报价单可能被多个订单共用；报价单总额不能直接替代订单销售额。

## 报价行 quoteLine

| 字段 | 中文标签/用途 |
|---|---|
| `quotationDetailEntityRelQuotationEntity` | 所属报价单 |
| `quotationDetailEntityRelProduct` | 产品 |
| `quantity` | 报价数量 |
| `priceDomestic` | 实际报价单价 |
| `amountDomestic` | 实际报价金额 |
| `aggregatedPriceDomestic` | 汇总单价/配置估值，不是收入 |
| `aggregatedAmountDomestic` | 汇总金额/配置估值，不是收入 |
| `customItem1__c` | 规格型号 |
| `customItem5__c` | 计量单位 |
| `customItem21__c` | 标准价 |
| `customItem25__c` | SKU/报价产品编码 |
| `customItem26__c` | 配置参数（拼接） |
| `customItem55__c` | BOM 类型 |
| `customItem56__c` | 完整配置参数 |
| `customItem57__c` | 是否组合产品 |
| `parentLine` | 上级报价行 |
| `rootLine` | 顶级报价行 |
| `optionLevel` | 报价行层级 |
| `aggregate` | 是否汇总 |
| `aggregateToParent` | 是否汇总到父级 |
| `customItem49__c` | 商机明细关联 |
| `customItem50__c` | 原订单编号 |

关键规则：

```text
priceDomestic > 0：有实际报价
priceDomestic = 0：通常是打包/配置行，不能直接认定免费
aggregatedAmountDomestic：配置估值，不能当成交收入
```

做报价结构时必须先处理父子层级；父行和子行不能同时相加。

## ZStone/ZCE 识别更正

用户确认：标准上架产品/HCI 配置中，配置含 `ZStack分布式存储软件V5.0` 即为含 ZStone 版本；已知产品编码示例 `PD000762`、`PD000763`。

识别优先级：

1. `quoteLine.customItem25__c` 产品编码匹配已确认 ZStone SKU；
2. 关联 `product.customItem174__c`、`customItem196__c`、`customItem237__c`、`customItem248__c` 配置/分类字段；
3. `quoteLine.customItem26__c` / `customItem56__c` BOM 配置；
4. 产品名/规格关键词仅作辅助。

不能把“ZStack分布式存储V3.0”“块存储”“分布式存储”单独当作 ZStone；它们可能对应 ZCE、ZStone、第三方存储或其他版本，必须回查产品编码和 HCI 配置。

订单级统计要区分：

```text
ZStone/ZCE 项目数：按订单去重
standalone_storage_amount：独立报价行实际金额
bundled_storage：通过标准上架产品/HCI 配置识别、但打包在父行的存储
```

配置估值和标准价不能直接当实际存储收入。

## 产品 product

| 字段 | 中文标签/用途 |
|---|---|
| `id` | 产品 ID |
| `productName` | 产品名称，可能是开票名称 |
| `priceUnit` | 标准价格 |
| `fscProductModel` | 规格型号 |
| `fscProductSpec` | 产品规格 |
| `customItem157__c` | 产品线类型 |
| `customItem193__c` | 产品线（部门） |
| `unit2__c` | 计量单位 |
| `customItem196__c` | 采购产品规格 |
| `customItem227__c` | 发票打印规格 |
| `customItem242__c` | 询价编号 |

产品名称不能单独决定硬件/软件性质，须结合规格、BOM 和报价行。

## 价格表 priceBook / priceBookEntry

标准价格表：

```text
priceBook.id = 3222340301701443
priceBook.name = 标准价格表
```

`priceBookEntry` 关键字段：

| 字段 | 中文标签/用途 |
|---|---|
| `priceBookId` | 价格表 |
| `productId` | 产品 |
| `productPrice` | 标准价格 |
| `bookPrice` | 价格表价格 |
| `productPriceDomestic` | 本币标准价格 |
| `fscProductModel` | 规格型号 |
| `fscProductSpec` | 产品规格 |
| `customItem23__c` | 计量单位 |
| `enableFlg` | 启用状态 |
| `maintenanceStatus` | 是否暂无价格 |

标准价可以做产品价值参考，不能替代合同金额、确收金额或实际成交价。

## 当前分析映射

### 主战场

```text
order.amount >= 0
order.customItem428__c = 国内业务事业部
order.isCube__c = true
orderProduct.quantity（有效计价硬件父行）
```

自动排除候选：

```text
<=2 台
FB/三方服务器/复杂非标 BOM
极端大项目
变更/冲销/0金额协议
```

保留 `main_battlefield`、`exclude_reason`、`review_reason`，自动规则不等于业务确认。

### 信创

BOM/合同/规格关键词：

```text
鲲鹏、海光、飞腾、兆芯、国产化、信创、ARM
```

非信创候选：Intel/AMD/x86 且无国产平台证据。无法判断标记 review。

### 存储

`ZStone`、`ZCE`、`ZCE-X` 从产品名称、规格、BOM 和确收分类综合识别。订单去重，不按报价行数计项目。

### 全闪

全闪确定关键词：全闪、All Flash、SSD-only、NVMe-only；Cube3300S/混闪只作候选，需要 BOM/产品线确认。

### 毛利

确收官方口径优先使用 FY27 拆分明细汇总表；订单内部测算使用有效计价父行收入和成本，但必须报告成本覆盖率，不把成本为空按 0 的结果称为财务毛利率。

## 原始资料

- `crm-field-metadata-full.json`：9 个对象完整 describe；
- `crm-key-field-dictionary.json`：关键词筛选字段；
- `crm-enums-and-relations.json`：枚举和关联字段；
- `订单金额核对口径.md`：订单/父行/报价行核对；
- `FY27一体机拆分明细-毛利核查结论.md`：确收毛利口径；
- `FY27一体机分析-数据需求与规则.md`：最终分析验收规则。
