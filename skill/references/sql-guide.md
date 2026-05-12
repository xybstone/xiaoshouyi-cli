# 销售易 SQL 查询语法指南

## 概述

销售易 CRM 支持通过 SQL 语法查询数据。`xsy query` 命令直接执行 SQL 语句返回结构化结果。

## 语法

```sql
select field1,field2,field3
from apiKey
[where conditions]
[order by field [asc|desc]]
[limit offset,size]
```

## SELECT 子句

- 必须列出具体字段名，**不支持 `*`**
- 多个字段用逗号分隔
- 字段名区分大小写（通常为 camelCase）

```sql
select id,accountName,phone,industry,createdAt from account
```

## WHERE 子句

### 支持的操作符

| 操作符 | 示例 |
|--------|------|
| `=` | `accountName = '华为'` |
| `!=` | `stage != '已关闭'` |
| `like` | `accountName like '华%'` |
| `not like` | `accountName not like '测%'` |
| `in` | `id in ('1', '2', '3')` |
| `not in` | `stage not in ('已关闭', '已丢单')` |
| `is null` | `phone is null` |
| `is not null` | `phone is not null` |
| `>`, `<`, `>=`, `<=` | `money > 10000` |
| `between ... and ...` | `createdAt between '2024-01-01' and '2024-12-31'` |

### LIKE 限制

**仅支持后缀通配**：`field like 'value%'`

```sql
-- ✅ 正确：后缀通配
select id,accountName from account where accountName like '华%'

-- ❌ 错误：前缀通配
select id,accountName from account where accountName like '%华为'

-- ❌ 错误：中间通配
select id,accountName from account where accountName like '%华%'
```

### 组合条件

用 `and` / `or` 连接：

```sql
select id,opportunityName,money from opportunity
where stage = '商务谈判' and money > 50000
```

## ORDER BY

- 语义命令（account list）通过 `--sort` 白名单支持有限字段（id/accountName/createdAt）
- 通用 `xsy query` 命令可直接传任意字段名，无此限制
- 默认升序，可指定 `asc` / `desc`

```sql
select id,accountName from account order by id desc
```

## LIMIT 分页

格式：`limit offset,size`

```sql
-- 第1页，每页20条
select id,accountName from account limit 0,20

-- 第2页
select id,accountName from account limit 20,20

-- 第5页
select id,accountName from account limit 80,20
```

每页最多 100 条。超过 `totalSize` 需要多次分页查询。

## 响应格式

```json
{
  "code": 200,
  "msg": "操作成功",
  "result": {
    "totalSize": 150,
    "count": 20,
    "records": [
      { "id": 2048503, "accountName": "销售易", ... },
      { "id": 2048504, "accountName": "华为", ... }
    ]
  }
}
```

## 常用查询示例

### 客户

```sql
-- 列表
select id,accountName,phone,industry,createdAt from account limit 0,20

-- 搜索
select id,accountName,phone from account where accountName like '华%'

-- 按行业筛选
select id,accountName from account where industry = 'IT'

-- 某时间段创建的客户
select id,accountName,createdAt from account
where createdAt between '2024-01-01' and '2024-06-30'
order by id desc
```

### 商机

```sql
-- 列表
select id,opportunityName,customerId,stage,money,createdAt from opportunity limit 0,20

-- 高价值商机
select id,opportunityName,money from opportunity where money > 100000

-- 活跃商机
select id,opportunityName,stage from opportunity
where stage not in ('已关闭', '已丢单')
```

### 跟进

```sql
-- 列表
select id,content,visitDate,customerId,creator from visitRecord limit 0,20

-- 某客户的跟进
select id,content,visitDate from visitRecord where customerId = '2048503'
```

## 技巧

- 先用 `xsy describe <apiKey>` 了解对象有哪些字段
- 用 `xsy account list --format table` 快速浏览数据后，再用 SQL 精确查询
- 查询结果中的 `totalSize` 用于判断是否需要分页
