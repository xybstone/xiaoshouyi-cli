# 销售易 API Key 参考

## 业务对象

| 对象名称 | apiKey | 说明 | 主要字段 |
|----------|--------|------|----------|
| 客户 | `account` | 客户/公司信息 | accountName, phone, industry, createdAt |
| 商机 | `opportunity` | 商机/销售机会 | opportunityName, customerId, stage, money, createdAt |
| 商机阶段 | `oppProcess` | 商机 Pipeline 阶段定义 | name, orderNum |
| 跟进记录 | `visitRecord` | 客户跟进/拜访记录 | content, visitDate, customerId, creator |

## 字段说明（Describe 返回结构）

```json
{
  "propertyname": "accountName",
  "label": "客户名称",
  "type": "text",
  "required": true,
  "creatable": true,
  "updatable": true
}
```

| 属性 | 说明 |
|------|------|
| `propertyname` | API 字段名（用于 SQL 查询和 --data） |
| `label` | 中文显示名 |
| `type` | 字段类型（text, number, datetime, picklist 等） |
| `required` | 是否必填 |
| `creatable` | 创建时是否可写 |
| `updatable` | 更新时是否可写 |
| `referToObjectApiKey` | 关联对象 apiKey（若为查找字段） |
| `options` | 下拉选项（picklist 类型） |

## 获取最新字段定义

```bash
xsy describe account
xsy describe opportunity
xsy describe visitRecord
xsy describe oppProcess
```

## 自定义对象

销售易支持自定义对象（custom objects）。使用 `xsy describe <customApiKey>` 获取其元数据。
