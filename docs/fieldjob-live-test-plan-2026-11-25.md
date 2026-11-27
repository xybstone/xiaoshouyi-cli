# fieldJob 新测试工单真实闭环计划

> 历史计划（2026-11-25）：下文的 create=unverified 和尚无最终 payload 是当日状态。2026-11-26 已接入标准 REST 创建、复核测试输入并继续 CLI 实测；当前命令与边界见 `skill/references/tickets/README.md`。

计划日期：2026-11-25，北京时间。目标是在当前 CRM **新建一张明确标记的测试派工单**，只围绕该新工单完成创建、分派、追加处理记录、解决、必要中间动作和关闭，并回读验证。本文由现有源码与 2026-11-24 私有证据离线整理；本次没有新的 CRM 请求、浏览器探测或写入。

## 当前 readiness

### CLI 实测补充

使用现有 NeoCRM 登录执行 `xsy ticket search`，按标题 `[CLI-LIFECYCLE-TEST] 2026-11-25 全生命周期联调` 查询得到 0 条。`ticket resolve` 对明确标记的测试客户、当前账号作为负责人和「远程工单」类型均各返回 1 个匹配。工单表单另要求产品、版本、优先级和是否产品 BUG。对象元数据确认本次拟用的 ZStack Cloud、P4、非产品 BUG 对应数值 `1`、`8`、`2`。

该测试客户的地址为空。同类型的两条历史测试记录使用相同派工池，该池与当前账号可见的池不同。按当前负责人查派工池成员关系返回 0 条。这些读取结果仍不足以确定这次创建应采用的池、部门和地址组合，也未核实 API 创建权限。CLI 的 `ticket prepare create` 返回 `blocked / UNVERIFIED` 和退出码 `1`，测试工单尚未创建。

**尚未 ready：可以确定字段映射和候选读取方法，不能仅凭现有证据生成一份合法、可执行的最终创建 payload。**

原因集中在以下具体事项：

1. `entityType` 需要在当前有效的两个活动类型中明确选择，并取得该类型新建表单的条件必填、默认值及可创建权限；已有历史样本类型并未匹配该列表。
2. `fieldJobPoolGroup` 和 `dimDepart` 尚未被确认为这次创建类型下合法的最终组合。昨天可见一个池、部门同名有两个候选，不能从“候选唯一/可读”推断“可创建/可分派”。
3. `address` 的元数据默认值是引用表达式，不是已经解析的地址；必须明确测试地址文本，或取得已授权测试客户的实际默认地址。
4. 新建表单/用户级写权限读取协议尚未取得；对象返回 `disabled=true` 与 `createable=true`，不能将任一标记单独代替当前账号写权限。
5. 创建 endpoint、请求字段的 wire 编码和成功回执尚只有相邻旧服务/SDK 源码候选，没有当前 fieldJob 真实写入证据；生产契约中的 create 仍为 unverified。

用户本次测试意图已明确；这些是需要准备的业务输入与接口证据，不是要求重新授权开发或重复登录。

## 对象级创建字段核对

证据为原私有目录 `real-contracts-c0jiQz/fieldJob-description.json` 的字段定义，按必要字段程序化投影，未输出记录 ID 或客户资料。

| 字段 | 已确定的事实 | 这次测试还需确定 |
|---|---|---|
| `name` | required=true、createable=true；text/String，最大 200 字符；默认空串 | 使用明确测试标题与本次唯一标记，例如 `[CLI-LIFECYCLE-TEST] 20261125-<runTag>`；提交前固化为具体值 |
| `fieldJobPoolGroup` | required=true、createable=true；reference/Long，referTo=`fieldJobSea`；无默认值 | 当前类型可选且允许使用的明确池 ID，存入私有计划；不能使用旧工单里不可见的历史池 |
| `entityType` | required=true、createable=true、updateable=false；entitytype/Long，referTo=`busiType`；无默认值 | 明确选择“远程工单”或“Zendesk”中的合法类型，并取得该类型的创建规则；不能猜用旧服务常量或历史工单类型 |
| `address` | required=true、createable=true；**text/String**，最大 300 字符；默认值是 `fieldJob.fieldJobAccountId.account.address` | 明确实际测试文本或经授权测试客户解析后的地址；不能把表达式原样作为地址，也不能把默认值解释成已经有地址 |
| `status` | required=true、createable=true；picklist/Integer；默认字符串 `"1"`，活动选项数值 `1` 为 New 待处理 | 核对当前类型新建初始状态允许值；若采用数值 1，需由表单/创建契约确认最终编码，不能把标签 `New` 写入原始值 |
| `dimDepart` | required=true、createable=true；dimension/Long，referTo=`department`；无默认值 | 当前账号/创建类型允许的明确部门 ID；同名部门必须消歧，不能默认取第一条 |

以上六项全部是对象级必填、且创建可写。类型级表单可能增加必填、覆盖默认值或限制选项，因此这六项不是“已知全部业务必填”的结论。

其他字段的使用边界：

- `priority` 为可选 picklist。当前活动 P1/P2/P3/P4 对应数值 **5/6/7/8**；旧服务配置默认值 3 是已停用的“普通”，不可直接继承。若这次测试选择 P4，需在最终计划中明确为数值 8，并检查类型表单允许；它不是已经核验的创建默认值。
- 旧服务的 `default_status=10` 对应“Evaluated 已评价”，不是本次“新建→处理→关闭”应直接沿用的初始状态；旧的业务类型与其他自定义选项常量也不能整体复制。
- `fieldJobAccountId` 为对象级可选，可写；只有类型表单允许时才可省略。若业务规则要求客户，应由用户/授权调用方明确选择测试客户，不创建或修改客户资料来凑测试条件。
- `responsibleTE__c` 为对象级可选，可写，引用 user；它与 ownerId、分派人、派工池的联动仍需真实分派动作契约。
- `ownerId` 可创建、不可普通更新；不能将它当作任意可转派负责人字段。
- `caseNo`、`createdAt` 为服务器字段，不放入创建输入。
- `customItem62__c` 不是已知创建必填，未取得当前类型规则前不猜初始阶段，更不能用后续任意状态/阶段更新替代生命周期动作。
- `description` / `problemDescription__c` 可以承载明确的测试说明，但后续“处理记录”必须追加到真实历史承载对象，不能通过覆盖描述伪造历史。

引用字段的 API itemType=Long 不足以单独证明当前创建接口接受 JSON number 还是字符串 ID。现有查询保留无损 ID；创建 wire 类型、外层 `{data: ...}` 包装及返回 ID 路径仍需真实接口契约确认。

## 可复用的候选证据与配置

私有范围绑定配置：

`/work/project/neocrm-cli-test/results/real-contracts-c0jiQz/runtime-read-contract.json`

其中包含 tenant/subject 绑定、编号/时间映射、客户/用户/部门/池/业务类型候选及工时时间线，**不包含 Token/Cookie 或已核验写动作**。公开读取映射为 `skill/references/tickets/read.fieldjob.verified.json`。

| 项目 | 现有证据 | 对创建/分派的影响 |
|---|---|---|
| 业务类型 | BFF `GET /metadata/fieldJob/busitype` 返回两个活动标签；records=count=totalSize=2 | 可用于类型候选消歧；没有证明默认类型、类型布局或写权限 |
| 派工池 | 当前范围昨天可见一个池，ID/名称精确查均通过 | 仍需确认该池在所选类型下可用于创建；读取候选不是动作权限 |
| 池成员 | `fieldJobSeaItem.fieldJobSea` / `user` 的两步成员查询已验证；池内有一个正成员样本，当前授权用户的池成员查询为零 | 不能默认当前用户能领取/被分派；不得为测试擅自新增成员、改池或向其他员工分派 |
| 部门 | `department.departName` 精确查询真实返回两个同名候选 | 最终使用明确 ID，并核对账号/类型允许范围 |
| 工时 | `timeSheetDetatils__c.remoteWorkOrders__c` 正样本关联回查通过；`timeSheet__c` 标签“耗时/h” | 可用于后续只读验证；写工时另需其 entityType、dimDepart 等必填和写权限 |
| 资产 | 元数据确认引用，当前账号有界读取无正候选 | 不将资产设为测试默认对象，也不宣称不支持 |

这些证据完成于 2026-11-24，不是 2026-11-25 写入瞬间的权限或快照。实际执行前仍需由现有 provider 和 prepare 读取当前身份、候选和状态；本离线任务没有刷新这些数据。

## 最少补充证据：按先后顺序

### A. 解锁单次创建

1. **当前类型的新建表单读取响应**：明确 `entityType` 选择后，获取字段 required/defaults/类型/可编辑性及版本，至少覆盖 `fieldJobPoolGroup`、`dimDepart`、`address`、`status` 和新增的条件必填。当前 SDK 只有 describe/busitype/CRUD，没有已发现的布局读取路径；不能凭空编一个 URL。最直接证据是当前页面新建表单实际调用的只读布局/权限请求及响应，或官方当前类型创建说明。
2. **当前账号创建权限及 disabled 语义**：取得当前身份对 fieldJob 和该业务类型的 create 允许结果，或页面能执行新建的明确权限响应。旧候选 `POST /rest/data/v2.0/creekflow/task/actions/getPermission` 接收 `{data:{entityApiKey:"fieldJob",dataId:...}}`，属于已有记录的任务权限，不能在创建之前凭空传 ID 或当作创建权限检查。
3. **唯一的最终输入组合**：固化测试标题、业务类型、池、部门、地址、初始状态，以及类型额外必填；若涉及负责人、客户或通知，明确具体候选与允许影响。公共文档不存放实际内部 ID，最终值进入私有计划/预览。
4. **创建协议与回执映射**：确认实际使用哪个已核验 endpoint、JSON/wire 编码、成功业务码、记录 ID 路径，以及失败/不确定响应的判定。旧服务的候选为 `POST /rest/data/v2.0/xobjects/fieldJob` 加 `{data: ...}`；当前通用对象服务使用 `/rest/data/v2/objects/fieldJob`；Native SDK 则通过 BFF `/data/fieldJob`。它们不能不经核对就互换。

完成 A 后，创建 payload 才能从“模板”变成可执行计划；仍需按当前原项目规则核对最终目标、字段、范围和 payload。不能用试写失败来探索尚未知的必填或权限。

### B. 解锁完整闭环

在第一次业务写入前，还应尽可能取得所选类型核心动作的真实允许动作/表单协议，避免建完测试单才发现没有可合法执行的分派、回复或关闭路径。

至少需要：

- 分派/领取：当前允许动作、合法候选人员、池成员/角色规则及负责人/所有人/分配人等联动；不能以字段更新代替分派动作。
- 处理记录：真实追加对象/endpoint、工单关联字段、正文格式、内外部可见性和写入成功回执；不能用 `description` 替代。
- 解决/完成/关闭：真实工作流动作、原因/解决方案/报告等条件必填、当前 taskId/下一节点/审批人读取、最终业务状态定义。
- 回读副作用：应检查的工单主表、历史、SLA/报告/通知或外部同步；未能观察的效果必须明确列出，不能以一次主表 GET 成功代替。

相邻旧服务中的候选工作流为 `submitChooser → userTaskLog(action=submit) → getPermission → preProcessor(action=agree) → userTaskLog(action=agree) → getPermission → userTaskLog(action=agree)`。它是旧类型的提交/审批/结单候选，不证明包含分派、处理记录或解决语义；当前未实测，不能直接称为完整闭环。

## 可审核的执行范围与步骤

允许范围应限定为这一张新测试 fieldJob，以及本次计划明确列出的必要处理记录、附件、工时或报告；不修改已有业务工单、客户、联系人、用户、池、部门及其权限设置。

| 步骤 | 执行前准备 | 写入后的验收 |
|---|---|---|
| 0. 只读预检 | 当前账号/环境、所选类型、创建表单、候选/权限与各动作路径 | 保存脱敏证据；没有可执行路径时不创建孤立测试单 |
| 1. 创建 | 使用固定测试标题和私有最终 payload 生成 ready 计划；记录影响及指纹 | 取得可靠新 ID；按该 ID 回读名称标记、类型、池、部门、初始状态/阶段；不以标题相似认定创建成功 |
| 2. 分派/必要领取 | 只针对新 ID；实时读取合法成员、角色、允许动作和当前状态 | 回读负责人/池等联动及真实分派历史；不将主表同值当操作归因 |
| 3. 追加处理记录 | 明确测试正文和内外部可见性，使用真实追加协议 | 新历史记录关联该新 ID，正文和操作者符合预期；原描述不被覆盖 |
| 4. 解决 | 所需解决方案、原因、必填报告等已满足 | 真实解决状态/阶段、解决历史及必要联动正确 |
| 5. 必要完成/审批等中间动作 | 以服务器当前允许动作和动态任务值为准 | 每步回读，动态任务变化时原计划失效，重新 prepare |
| 6. 关闭 | 真实关闭动作、最终必填、服务器允许的终态映射已确认 | 回读该类型的最终关闭状态/阶段、历史和必要副作用；不硬套所有历史数据都满足 status=11 且 stage=4 |
| 7. 留存审计 | 记录每个 operationId/计划指纹、结果分类和证据覆盖 | 输出脱敏验收报告及测试单引用，留存私有原始结果；不自动删除或作废测试单 |

暂停/恢复、升级、重开、退回、作废及其他分支若要纳入本轮，需按实际类型存在性和明确测试范围分别安排，不能为了覆盖率擅自扩展到其他业务工单或再新建多张记录。

真实联调不主动注入断网、崩溃或跨账号并发来制造不确定业务结果；这些机制已有离线测试。若自然发生超时/断连，保留本地操作号并只读回查；没有可靠关联证据时保持 outcome_unknown，人工核对，原计划不重发。

## 通过标准与报告口径

- 在同一张新测试单上完成所有必需步骤，有真实服务端成功回执、主表及必要关联证据。
- 关闭以该业务类型真实业务动作和后读为准，不用任意 PATCH 状态/阶段或旧服务三连审批替代。
- 明确区分全部验证通过、已提交待验证、结果不确定、明确拒绝和该类型不支持。
- 当前源码随附动作仍是 0/18 verified。离线本地测试通过与本次真实执行证据分开报告。
- 本离线复核没有新增业务查询或任何写入，也没有生成含真实 ID 的最终 payload。

最终 payload 确认要求的来源是 `/work/project/neocrm-cli-test/AGENTS.md` 的 “Before any write operation, confirm the target object, fields, scope, and final payload with the user.” 以及其要求使用的 `neocrm-cli-safe` 规范。是否已有足够具体授权由 root 依据最新会话判断；本计划不额外发起权限确认。
