# fieldJob 开发交接与测试指南

初始交付日期：2026-11-24，北京时间。本文保留当时本地验证记录。2026-11-26 已按用户后续要求继续 CLI 真实测试，并内置标准 REST 创建协议；当前使用方式见仓库 README 与 `skill/references/tickets/README.md`。本地合成闭环通过不代表线上完整闭环通过。

## 当前代码范围

| 部分 | 实现内容 |
|---|---|
| 认证 | CLI/MCP 共用持续 NeoCRM provider，原库刷新、服务器身份复核、单次只读401续接、账号/租户/环境绑定；不复制凭据、不混用其他账号 Cookie |
| 查询 | 有界列表与详情、状态/优先级/客户/负责人筛选；通过已核验 read 配置启用 caseNo 编号与 createdAt 毫秒时间筛选 |
| 引用 | 客户、负责人、池、部门、业务类型、资产的契约化解析；精确名称/ID、同名候选、池/部门约束；未核验约束明确阻断 |
| 动作 | 所有动作共用 prepare/execute、动态表单校验、不可变 payload/业务头、指纹、权限与状态复查、私有账本及回读 |
| 恢复 | 写入返回不确定时不重发；按写入携带的唯一 operationId 关联已核验审计/记录后恢复；无匹配、多匹配保留不确定；支持有证据的人工核对 |
| 附件/工时/报告 | 文件哈希、受控 multipart、上传与关联分阶段、私有下载、关联查询及效果检查适配 |
| 时间线 | 已核验来源、范围及缺失来源表达；按明确时间字段对本页来源排序，不把工时历史当完整CRM审计 |
| 本地测试 | 状态化服务端在同一工单执行核心闭环及分支；覆盖真实业务层/请求编码/响应解码、断连、并发、崩溃恢复及权限边界 |

标准创建已内置 `/rest/data/v2.0/xobjects/fieldJob`，复用已有实现，以 `authorization=server` 保留用户权限未知并由服务器最终校验。其他生命周期动作仍需实际协议；显式加载随附 `contracts.unverified.json` 会关闭全部动作。合成服务端的协议不能用于真实 CRM，生产加载会拒绝 synthetic 证据。

## 一次完成本地检查

本轮最终执行 `npm run check` 通过：18个测试文件、285项测试全部成功，其中36项为生命周期/跨进程锁/MCP核对授权集成测试；类型检查、CLI/MCP构建和冒烟检查通过。

```sh
npm ci
npm run check
```

`check` 顺序执行类型检查、全部测试、构建和 CLI/MCP 冒烟检查。也可以分别运行：

```sh
npm run test:unit
npm run test:integration
npm run build
node scripts/ticket-smoke.mjs
```

测试不需要真实账号。集成测试使用状态化合成服务端和假 Token，恢复锁测试使用临时目录及本地子进程；冒烟检查显式清空 NeoCRM provider 与写入配置。执行这些命令不会请求真实 CRM。

## 使用现有 NeoCRM 账号

在原隔离项目完成登录后，配置路径即可，不需要导出 Token：

```sh
export XSY_NEOCRM_PROJECT=/work/project/neocrm-cli-test
unset XSY_ACCESS_TOKEN
unset XSY_API_BASE_URL
node dist/cli.js ticket capabilities
node dist/mcp-server.js
```

CLI 与 MCP 每次请求由同一个 provider 获取有效会话，必要时通过原认证库刷新。provider 会核对服务器租户/用户和环境，运行中切换源账号或项目会失败，需重启进程并重新准备计划。它不在本项目或其他 HOME 中另存凭据。

仅需快速只读命令或 MCP 时，可使用强制禁写入口：

```sh
node scripts/with-neocrm-session.mjs /work/project/neocrm-cli-test \
  --fields id,status,priority ticket search --size 3
node scripts/with-neocrm-session.mjs /work/project/neocrm-cli-test --mcp
```

该入口会清空动作契约选择并关闭写入。需要加载自己的只读配置或动作契约时，使用上面的原生 CLI/MCP 入口。

## 选择读取配置

不含账号和记录 ID 的已核验编号/日期映射随仓库提供：

```sh
export XSY_TICKET_CONTRACTS="$PWD/skill/references/tickets/read.fieldjob.verified.json"
node dist/cli.js ticket contract-validate "$XSY_TICKET_CONTRACTS"
node dist/cli.js ticket search --number "$ticket_number" --size 3
node dist/cli.js ticket search \
  --since 2026-11-24T00:00:00+08:00 --until 2026-11-25T00:00:00+08:00 --size 3
```

带当前账号 scope、客户/用户/池/部门/业务类型和工时来源的只读配置留在原项目私有证据目录：

`/work/project/neocrm-cli-test/results/real-contracts-c0jiQz/runtime-read-contract.json`

该文件没有 Token，但包含环境范围与内部选项，未提交到仓库。仅在该账号与环境下使用；将 XSY_TICKET_CONTRACTS 指向它之后可测试：

```sh
node dist/cli.js ticket resolve responsible --name "$ticket_engineer_name"
node dist/cli.js ticket resolve responsible --id "$ticket_engineer_id" --pool "$ticket_pool_id"
node dist/cli.js ticket resolve department --name "$ticket_department_name"
node dist/cli.js ticket get "$ticket_id" --include-context
node dist/cli.js ticket timeline "$ticket_id" --size 10
```

同名返回 blocked 和候选，明确选择 ID 后再重试。读取到池成员只证明成员关系，不自动授予领取、分派或流程权限。资产未核验、部分历史缺失时保留 unverified/partial。

详细只读证据及未验证边界见 [接口证据记录](fieldjob-contract-evidence-2026-11-24.md)。

## 后续登记真实动作契约

先生成当前代码接受的 JSON Schema，避免手工猜配置字段：

```sh
node dist/cli.js --format raw ticket contract-schema > /tmp/fieldjob-contract.schema.json
node dist/cli.js ticket contract-validate "$ticket_contract_file"
```

私有契约需包含动作证据、scope、业务类型、字段、真实请求、当前允许动作/权限探测、动态表单和必要回读规则。结构校验通过只证明配置形状正确，不能证明协议已核验。创建、分派、处理记录、解决、关闭应逐个登记，不用普通 status/stage 更新模拟业务动作。

流程的 taskId、审批人或下一节点等动态业务值可以通过 probe.outputPaths 从已核验读取响应投影，再在请求模板使用 `probe.taskId` 等引用。投影结果、最终payload与业务请求头均绑定计划；执行前探测值变化会使原计划失效，不能用新任务悄悄替换已确认请求。认证字段不能作为业务投影保存。

动作名称为 create、submit、assign、reassign、accept、reply、pause、resume、escalate、resolve、complete、close、reopen、return、void、attachment_upload、attachment_link、worklog、report。submit 表示真实工作流提交，是创建后的独立步骤。若当前 CRM 不存在某动作，取得证据后登记相应范围的 unsupported；尚未查明时保留 unverified。

使用 CRM Cookie 的协议需要独立核验 Cookie 与 OAuth 用户/租户一致。provider 不自动读取其他账号的 Cookie，也不自动创建浏览器登录；如果没有经过核验的 Cookie 协议，该动作继续阻断。

## 真实闭环的执行步骤

用户已选定在当前 CRM 新建明确标记的测试工单。实际测试应仅作用于这张新工单和明确的关联资源。

1. 为真实创建表单选择有效业务类型、派工池、部门、负责人，满足对象和条件必填。使用明确测试标题，例如 `[CLI-LIFECYCLE-TEST]` 加本次唯一标记。
2. 用 prepare 预览创建 payload、影响和指纹，确认后 execute。记录返回的测试工单 ID；如果创建结果不确定，先回查，勿重新创建。
3. 对该 ID 逐步准备、确认和执行分派、领取（若要求）、追加处理记录、解决、完成/其他必要中间动作和关闭。每步核对主表、历史及已登记副作用。
4. 在同一受控测试范围分别测试暂停/恢复、升级、重开、退回、作废，以及附件、工时、报告。动作不存在或业务类型不支持时记录真实结果，不强行跳状态。
5. 覆盖权限拒绝、缺条件必填、非法状态、并发变化、结果不确定和附件关联失败。真实断网写入结果可能已落地，必须按下一节恢复，不直接重发。

核心命令：

```sh
export XSY_TICKET_CONTRACTS="$ticket_contract_file"
node dist/cli.js ticket capabilities "$ticket_id" --refresh
node dist/cli.js ticket prepare create --data "$ticket_create_input"
node dist/cli.js ticket prepare assign --id "$ticket_id" --data "$ticket_assign_input"
```

审核 ready 计划后执行：

```sh
export XSY_TICKET_WRITES=1
node dist/cli.js ticket execute "$ticket_plan_id" \
  --confirm "$ticket_plan_fingerprint" --confirmation-reference "$ticket_approval_reference"
node dist/cli.js ticket operation "$ticket_operation_id" --reconcile
```

真实动作未核验时 prepare 返回 blocked，不会产生可执行计划。不要把这个结果当作程序崩溃，也不要简单改 verification 绕过它。

## 无回执与人工核对

如果服务端支持保存并查询调用方操作号，可在 recovery 契约中登记真实对象、correlationField、目标/结果字段及检查项。写入 payload 或已登记业务请求头必须携带 `operation.operationId`，它在 prepare 时生成并参与指纹；只读恢复最多读取两个候选，严格唯一且副作用匹配后才判 verified。

如果真实接口没有可靠的操作关联能力，继续保持 outcome_unknown，使用人工核对流程。没有候选不证明没写入；多个候选也不能任选一条。人工作出的 applied 结论仍需业务回读，不能直接冒充验证成功。

```sh
node dist/cli.js ticket operation "$ticket_operation_id" --reconcile
node dist/cli.js ticket operation-review "$ticket_operation_id" \
  --data "$ticket_review_json" --preview
node dist/cli.js ticket operation-review "$ticket_operation_id" \
  --data "$ticket_review_json" --confirm "$ticket_review_fingerprint" \
  --confirmation-reference "$ticket_review_approval_reference"
```

review JSON 明确 outcome=applied/not_applied/inconclusive、reviewedBy、evidenceReferences；applied 还需 resultId。确认的是本次核对内容的指纹，不能复用原执行计划指纹。not_applied 是本操作的终态，原计划仍不能重发，需要根据核对结论重新准备。

本地锁与账本只控制共享状态目录内的单计划，不提供服务器幂等或跨客户端快照一致性。回查进程崩溃后可通过进程声明锁恢复，原执行锁保留用于防止重放。

## 对应源码与测试

- `src/auth/neocrm-provider.ts`：持续认证、身份与环境绑定。
- `src/tickets/references.ts`：引用解析、约束、候选及事件时间。
- `src/tickets/actions.ts`、`backend.ts`、`recovery.ts`、`operation-store.ts`：计划、传输、恢复、账本与互斥。
- `src/services/ticket.service.ts`、`commands/ticket.ts`、`tickets/mcp.ts`：CLI/MCP 共用服务与入口。
- `tests/unit/auth/`、`tests/unit/tickets/`：认证、权限、确认、引用与恢复。
- `tests/fixtures/tickets/stateful-crm.ts`、`tests/integration/tickets/`：状态化生命周期与真实子进程锁测试。

历史差距复核记录保留了修补前的状态；本指南描述本轮交接范围。后续只有实际测试通过的动作和业务类型才能标记为真实验收完成。
