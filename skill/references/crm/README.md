# CRM 字段资料

本目录由销售易 CRM `describe` API 生成，供 xiaoshouyi-cli skill 的查询和分析复用。

## 文件

- `crm-field-metadata-full.json`：`order`、`orderProduct`、`quote`、`quoteLine`、`product`、`priceBook`、`priceBookEntry`、`account`、`opportunity` 完整字段元数据。
- `crm-key-field-dictionary.json`：关键词筛选后的关键字段字典。
- `crm-enums-and-relations.json`：枚举、关联对象和可选值。
- `CRM字段字典与分析映射.md`：字段语义、对象关系、金额规则、BOM、主战场、信创、存储和全闪分析映射。

## 更新规则

字段类型、标签、关联对象和枚举以完整 metadata 为准；字段用途和业务口径以字段字典和项目规则为准。CRM 字段可能随租户配置变化，新增分析前应重新执行 `xsy describe <apiKey>` 或更新元数据文件。
