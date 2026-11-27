# fieldJob 真实只读契约证据

本文主体保留2026-11-24的只读核验历史；后续真实创建及工作流结单结果见 [2026-11-27 CLI 实测结果](fieldjob-live-verification-2026-11-27.md)。

核验日期：2026-11-24，北京时间。本文仅记录已经完成的有界只读核验及源码依据，不将候选写入协议或离线测试当作真实业务验收。用户后续明确先完成代码、真实 CRM 由其自行测试后，已停止在线 CRM 和浏览器探测。

## 已交付配置

- 可公开配置：`skill/references/tickets/read.fieldjob.verified.json`。仅启用已核验的编号和时间映射，不含凭据、租户/用户标识、工单 ID 或已核验写动作。已通过 `ticket contract-validate` 的离线结构校验。
- 当前账号私有读取配置：`/work/project/neocrm-cli-test/results/real-contracts-c0jiQz/runtime-read-contract.json`。包含环境/租户/账号绑定、读取映射、引用解析及工时时间线配置，不含 Token/Cookie。该文件不纳入仓库；执行时还需由可信认证提供器证明当前身份与 scope 一致。
- 原始响应与脱敏核验摘要：同一私有目录中的 `summary.json`、`references-summary.json`、`related-summary.json`、`positive-reference-summary.json`、`final-read-summary.json`。

私有目录权限为 0700，文件为 0600。核验过程中凭据由原 NeoCRM 认证库在内存中提供，没有读取到模型或复制凭据内容，没有重写 HOME/XDG 或向本仓库保存认证状态。

## REST 读取与字段证据

已使用的官方接口为：

- `GET /rest/data/v2.0/xobjects/{apiKey}/description`：读取对象/字段定义。
- `GET /rest/data/v2/query?q=...`：明确字段、明确条件的有界 XOQL 查询。

每次业务记录查询最多返回 1–3 条；元数据在本地程序中定向投影，没有将完整元数据或业务记录注入对话。

| 业务含义 | 已核验字段/关联 | 实际核验 |
|---|---|---|
| 工单编号 | `fieldJob.caseNo`，autonumber、不可创建/更新 | 读取一个样本编号后精确查询，唯一结果 ID 与原样本一致 |
| 创建时间 | `fieldJob.createdAt`，datetime | REST 返回 unix-ms；用 `[createdAt, createdAt+1)` 毫秒区间查询，包含原样本 |
| 更新时间 | `fieldJob.updatedAt`，datetime | 元数据及样本读取通过；未把它登记为具有服务器条件更新语义的并发版本 |
| 客户 | `fieldJobAccountId` → `account` | ID 条件筛选和样本回查一致 |
| 工单负责人 | `responsibleTE__c` → `user` | ID 条件筛选和样本回查一致 |
| 派工池 | `fieldJobPoolGroup` → `fieldJobSea` | ID 条件筛选通过；样本中的历史池引用在池对象查询中不可见，另核验了当前可见池 |
| 所属部门 | `dimDepart` → `department` | ID 条件筛选和样本回查一致 |
| 业务类型 | `entityType` → `busiType` | referTo 元数据确认；类型选项需使用下述 BFF 读取来源 |
| 客户资产 | `fieldJobAssetId` → `asset` | referTo 元数据确认；样本为空且当前账号资产有界查询返回零条，未宣称正样本解析已通过 |

编号及时间证据完成于 `2026-11-24T18:10:31+08:00`。`read.fieldjob.verified.json` 登记 `numberField=caseNo`、`createdTimeField=createdAt`、`dateEncoding=unix-ms`，不改变其他动作的 unverified 状态。

## 引用候选与消歧

| 引用 | 对象与名称字段 | 证据与可用边界 |
|---|---|---|
| customer | `account.id` / `account.accountName` | 元数据 nameField、ID 与名称精确查询均通过 |
| responsible | `user.id` / `user.name` | 元数据 nameField、ID 与名称精确查询均通过 |
| department | `department.id` / `department.departName` | 元数据、ID 与名称精确查询通过；真实同名查询返回两个候选，因此不得默认选第一条 |
| pool | `fieldJobSea.id` / `fieldJobSea.name` | 当前账号可见一个池，对其 ID 与名称查询均匹配；不能把样本中的不可见历史池当作创建默认值 |
| entityType | BFF 完整类型列表的 `id` / `label` | 两条活动选项，totalSize=count=records.length=2；仅作为当前范围的已知选项快照，不推断创建默认值 |
| asset | `asset.id` / `asset.name` | nameField 元数据为自动编号；缺少当前账号可见正样本，私有配置保持 unverified |

类型读取来源为原 NeoCRM SDK `getBusiType` 使用的 `GET /metadata/fieldJob/busitype`。当前两个活动标签是“远程工单”和“Zendesk”；最新工单样本的历史类型没有匹配这份列表，不能自动改写或猜选。通用 `busiType` 对象查询被业务拒绝，不能用它替代已成功的类型列表协议。

当前私有配置对类型使用已完整核验的 options 快照。它不是长期动态表单接口；上线使用前仍需按当前权限和配置刷新，并单独确认创建类型与默认值。

### 派工池成员关系

元数据确认 `fieldJobSeaItem.fieldJobSea` 引用派工池，`fieldJobSeaItem.user` 引用用户，`fieldJobSeaItem.depart` 引用部门。以下有界查询已实测：

1. 按明确池 ID 查询 `id,fieldJobSea,user,depart`，获得一个正成员样本。
2. 同时按池 ID 与当前用户 ID 查询，结果为零。该结果说明不能默认当前账号属于该池；它本身不证明所有分派/领取动作的权限。

使用两步解析：先在 `user` 精确解析候选，再按池和候选用户查询 `fieldJobSeaItem` 校验成员关系。私有 responsible 引用配置登记：

```json
{
  "membership": {
    "apiKey": "fieldJobSeaItem",
    "candidateField": "user",
    "poolField": "fieldJobSea"
  }
}
```

部门字段虽已在元数据中确认，但未实测成员关系的部门 WHERE 条件，因此不登记 departmentField 约束。尝试直接选取 `fieldJobSeaItem.user.name` 的引用 join 被业务码 `2040004` 拒绝，没有将其注册为可用查询。

候选唯一、池成员关系成立仍不等同于当前状态允许该动作；实时动作/角色权限继续由 prepare 阶段核验。

## 工时及其他关联读取

工时对象 `timeSheetDetatils__c` 已取得元数据和真实正样本，按 `remoteWorkOrders__c` 回查后匹配原工时记录。

| 字段 | 元数据/响应证据 |
|---|---|
| `remoteWorkOrders__c` | detail 类型，referTo=`fieldJob`，创建必填 |
| `timeSheet__c` | float，标签“耗时/h”，正样本返回 number；单位证据为小时 |
| `engineer__c` | reference，referTo=`user` |
| `openDate__c` / `endDate__c` | date 类型；已读取的发生日期返回 number，未据此推断其他日期字段或时区编码 |
| `createdAt` | datetime，正样本返回 number，可用于该来源事件时间 |
| `entityType` / `dimDepart` | 对象级创建必填，仍需当前类型/表单规则 |
| `name` | 自动编号，required=true 但 createable=false，创建时应由服务器生成 |

私有配置将工时作为已核验时间线来源，字段只含工单关联、耗时、发生日期及创建时间；同时保留未核验的“CRM history”来源，因此不能将工时记录当作完整 CRM 历史。

另外确认：

- `slaLog.fieldJobId` 明确引用 fieldJob，关联查询协议成功，但本次目标返回零条。不能据此宣称 SLA 的写入/暂停/恢复联动已验收。
- `fieldJobPool.fieldJobId` 明确引用 fieldJob，关联查询成功，但其含义是派工池视图，不是池成员表。
- `serviceReport` 的关联是 `relateEntity` / `relateEntity_data` 多态来源，没有直接 fieldJob 引用证据；未猜测为普通工单关联键。
- `activityrecord.activityRecordFrom` 同样引用 xobject，尚未核验工单关联及回复/可见性规则。
- `feed` 描述返回零个字段，不能据此推导动态/处理历史读取协议。

## 已发现但未核验的写动作来源

相邻项目 `/work/project/crm-ticket-service` 包含可复用的候选实现：

- `crm_ticket_service/crm_client.py:135`：fieldJob 创建请求；`:160`：工时创建请求。
- `crm_ticket_service/crm_workflow.py:52`：submitChooser；`:76`：getPermission；`:83`：preProcessor；`:116`：userTaskLog。

该项目 AGENTS.md 明确：工作流路径来自用户旧 FastGPT 导出，并未独立确认其线上稳定性或当前租户规则。它们是后续适配线索，不能直接变成 verified 生产契约。尤其 preProcessor 的 action=agree 不能仅因名称像预处理就被认定为无副作用。

本次没有请求以上工作流端点，没有创建或修改业务记录。服务提供的“submit→agree→agree”候选链不能自动代表所有业务类型的“创建→分派→处理→解决→关闭”。旧常量、业务类型 ID、状态值和自动结单注释也不作为当前测试默认值。

## 仍需真实 CRM 验收的边界

fieldJob 及 account/user/department/asset/池等对象的元数据均观察到 disabled=true，同时 queryable/createable/updateable=true；读取成功只证明读取能力。SDK 与 BFF 描述未提供用户级 permissions、创建布局或条件必填契约，disabled 的准确语义仍待官方或页面权限证据，不能从这些共同标记反推写权限。

仍未获得当前创建表单、默认/历史业务类型解释、允许动作与角色权限、附件上传/关联协议、报告模板及必要联动的真实证据。相应动作保持 unverified。用户已经选择代码先行、由其后续执行真实 CRM 测试，本文件不将这些环境验收项写成已完成。

## 请求结果与保留

私有证据目录保留约 2.4 MiB，包含完整元数据、受控业务响应、投影和配置；其中 43 个 REST 响应正文合计约 1.46 MiB，39 个取得成功业务码。另有 BFF 元数据与业务类型读取。

遇到两个 HTTP 429 后改为串行、每次间隔 1.2 秒，重试读取成功；没有把限流误判为永久不支持。其余业务拒绝为通用类型查询及未核验 join，未盲目扩大查询。

本次没有全量业务明细遍历。每次明确查询的完整性与总数分别核验；受限样本不宣称覆盖所有工单或业务类型。私有结果为本次接口验收证据，验收后可按原项目保留策略清理。生产写入次数为零。
# 2026-11-26 CLI 创建实测补充

用户授权在当前 CRM 新建一张明确标记的测试工单并验证闭环。通过原生 CLI 的 `ticket prepare create`、`ticket execute`，使用现有 NeoCRM provider，向 `/rest/data/v2.0/xobjects/fieldJob` 提交 `{data: ...}`；收到 `data.id` 后按该 ID 查询回读，标题和 `status=1` 均匹配，操作状态为 `verified`。只创建这一张新测试工单，未修改已有业务工单。本次证明当前账号、远程工单类型及本次具体输入的创建能力，不代表完整生命周期通过。

实测同时修复：description 的162个字段内容保持一致但返回顺序变化，原先直接对数组计算指纹会误报 PLAN_STALE；现在按字段 API key 和选项内容稳定排序后计算指纹，真正的可写性、必填或选项变更仍阻断。另修复通用输出丢弃字符串 `code="200"` / `data` 响应的问题。

私有输入、计划、操作账本、回执及回读输出存于 `/tmp/xsy-cli-live-20261126/`（目录0700、文件0600），没有将凭据或真实内部 ID 写入仓库。旧计划在发送前因 PLAN_STALE 停止，账本仍为 prepared；生成新计划前再次有界查重为0，再进行一次真实创建。完整闭环的其余动作仍逐步核验，不通过 PATCH 状态模拟关闭。
