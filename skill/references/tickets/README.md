# fieldJob 技服工单

代码接入日期：2026-11-24。主对象为 fieldJob；serviceCase 不作为别名。CLI/MCP 共用查询、能力判断、prepare/execute 和私有操作账本。

## 实际交付与核验边界

已实现结构化查询、详情、按需客户上下文、能力报告、时间线适配、动作执行框架、文件传输适配及 CLI/MCP。认证、HTTP、对象查询、输出和测试框架沿用现有模块。

后续代码补齐包括持续 NeoCRM provider、引用候选与约束、无回执恢复、人工核对及状态化集成测试。2026-11-26 新增内置 fieldJob REST 创建协议，直接使用 CLI；无需 Chrome。开发交接和验证步骤见仓库 `docs/fieldjob-development-handoff.md`。

默认配置内置 create；其他动作、时间线和附件下载需加载对应账号/业务类型的真实合同。2026-11-27新测试单已真实通过本人专用派工、独立活动记录及通用核心流程；准确范围和OAuth限制见 `docs/fieldjob-gap-verification-2026-11-27.md`。显式加载 `contracts.unverified.json` 会覆盖内置 create 并阻止执行。CLI 的 `ticket prepare` 遇到阻断时向标准错误输出 JSON 并返回退出码 `1`。

## CLI 创建

使用现有登录态，提供已核验的当前引用和字段值；不会猜测业务类型、派工池、部门、客户或负责人：

```sh
export XSY_NEOCRM_PROJECT=/work/project/neocrm-cli-test
unset XSY_ACCESS_TOKEN XSY_API_BASE_URL
xsy ticket prepare create --data "$ticket_create_input"
# 审核计划的 payload、影响和指纹后执行
XSY_TICKET_WRITES=1 xsy ticket execute "$ticket_plan_id" \
  --confirm "$ticket_fingerprint" --confirmation-reference "$ticket_approval_reference"
xsy ticket operation "$ticket_plan_id" --reconcile
```

create 使用 `authorization=server`：用户权限保留 unknown，由标准创建接口最终允许或拒绝；不伪造权限探测结果。只允许新建待处理工单（status=1），逐字段校验当前可写性、活动枚举、引用 ID 和必填。条件必填由服务器最终检查。普通流转仍需真实权限探测；另有严格限制本人、空服务团队、具体目标/池/类型的专用派工白名单，不将此模式泛化为任意分派或状态迁移。

已登记的 worklog 也可使用 server 模式，但仅允许 POST `timeSheetDetatils__c` 的指定路径：实时检查子对象的客户端必填、可写性、类型及父工单绑定，自动编号由服务器生成，缺新记录 ID 时保留不确定状态。当前环境已实测0.5小时；服务器业务步长规则需在对应业务契约中声明，不能从 float 类型推断任意小数都可写。

report 的 server 模式仅允许对明确 fieldJob 更新 `problemReason__c`、`reportText__c`。要求 scope、旧值检查和对应字段回读；payload 只能包含逐字段 input 引用。普通 CRUD 的 fieldJob 写保护继续生效。这个补录接口不代表独立服务报告对象，也不能用于更新状态、阶段或所有人。

本次远程测试单的最终状态、阶段、真实验收与未验收范围见仓库 `docs/fieldjob-live-verification-2026-11-27.md`。实际结果为状态9已解决、阶段4工单关闭、无当前任务，不将它改写成标准状态11。

写请求只发送一次。收到有效 ID 后回读 ID、标题与初始状态；断连或未知响应保留 outcome_unknown，不自动创建第二张。执行退出码：0=回读验证成功，1=明确拒绝或未落地，2=结果不确定，3=已有回执但回读未完成；非零结果写 stderr，包含只读回查命令。

## 构建与读取

```sh
npm ci
npm run typecheck
npm test
npm run test:integration
npm run build
node scripts/ticket-smoke.mjs
xsy ticket capabilities
xsy ticket --help
```

capabilities 默认离线。配置现有 XSY_ACCESS_TOKEN 或通过 auth login 登录后：

```sh
xsy ticket search --size 20 --status "$ticket_status_value"
xsy ticket search --customer "$ticket_customer_id" --responsible "$ticket_engineer_id"
xsy --fields id,name,status,priority ticket get "$ticket_id"
xsy ticket get "$ticket_id" --include-context
xsy ticket capabilities "$ticket_id" --refresh
xsy ticket timeline "$ticket_id"
xsy ticket workflow "$ticket_id" --include-submit-chooser
xsy ticket service-report-preflight "$ticket_id" --template-name '通用派工报告(示例)'
```

`workflow` 只读发现当前任务和服务器允许动作，不调用预处理。`workflow_preprocess` 必须单独prepare/execute，后续advance/close从同一私有账本引用其已验证操作，不接受模型提供的原始预处理数据。`activity_record` 是CRM活动记录，不等同客户回复。

`fieldJobHistory` 配置含当前scope、父对象类型映射及证据后，timeline可合并活动、独立报告和流程历史；仍只标partial，不把无记录当完整历史。独立报告预检返回模板/表单/规则计数，不返回实际收件邮箱，也不生成或发送。

附件关联使用已核验的masterdetails专用协议，只有doc字段正向回读才算verified；SQL空值/省略和保存ACK不能代替它。当前OAuth的页面doc读取返回`passport not found`，相关操作保留待验证。只核验本人已上传文件时可用`xsy ticket attachment-download-upload "$upload_operation_id" --upload-only`；它校验原文件哈希并明确返回`associationVerified:false`。省略该选项仍要求工单关联通过。

筛选使用元数据中的原始选项 value；P1/P2/P3/P4 是已报告的活动优先级标签，不能假定与 value 一致。元数据字段按真实 apiKey/createable/updateable/isActive 解码。disabled 与对象 createable 标记保留原值，不代替用户权限。

--refresh 只证明 describe 可读；指定记录 ID 并成功查询后才标记记录读权限。列表默认20条、上限100条、按id排序，JSON 在服务层先裁剪字段；offset 分页不宣称快照一致性。默认列表不含标题、客户或联系人资料，需按需选择字段。

编号 caseNo 和创建时间 createdAt 的 unix-ms 编码已通过有界只读核验，配置位于 `read.fieldjob.verified.json`。将 XSY_TICKET_CONTRACTS 指向该文件后可使用 --number/--since/--until；未加载映射时仍返回 UNVERIFIED。日期使用含时区 ISO 字符串，区间为 [since, until)。客户上下文复用 account 查询；资产对象与历史来源未核验时返回 partial/unverified，不解释为空历史。

## 契约配置

### 复用现有 NeoCRM 登录态进行只读测试

已批准的 `/work/project/neocrm-cli-test` 使用独立加密存储。持续 provider 调用它现有的认证库提供有效 Token 和 API origin；不实现另一套解密、不复制凭据、不改 HOME/XDG，也不写入本项目 .env 或其他认证目录。必要的刷新仍由原库在原隔离目录内完成。每代 Token 与定时服务器身份核验绑定账号、租户和环境，源账号切换后需重启进程并重新准备计划。

原生 CLI 与长期运行 MCP 使用同一个 provider：

```sh
export XSY_NEOCRM_PROJECT=/work/project/neocrm-cli-test
unset XSY_ACCESS_TOKEN
unset XSY_API_BASE_URL
node dist/cli.js ticket capabilities
node dist/mcp-server.js
```

该模式拒绝同时使用静态 Token、跨域 API 覆盖和重定向；只读401最多通过原库续接一次，写请求不自动重放。CRM Cookie 必须来自明确配置并独立核验身份，不读取、保存或清理其他账号 Cookie，也不自动创建 CRM 登录。

```sh
node scripts/with-neocrm-session.mjs /work/project/neocrm-cli-test \
  --fields id,status,customItem62__c,priority ticket search --size 3
node scripts/with-neocrm-session.mjs /work/project/neocrm-cli-test \
  ticket capabilities --refresh
node scripts/with-neocrm-session.mjs /work/project/neocrm-cli-test --mcp
```

该快速入口仅允许 search/get/capabilities/timeline/resolve 及 MCP，强制关闭工单写入并清空契约选择；其 --mcp 通过同一 provider 持续供给会话。需要自己的引用/read/动作契约时用原生 CLI/MCP。代理 CLI 的枚举标签数组与 REST 的数值须经元数据对应，不应直接比较 JSON 形状。代理调用的原始输出仍需按原 CLI 规则保存在批准的私有结果目录。

```sh
xsy --format raw ticket contract-schema > /tmp/fieldjob-contract.schema.json
xsy ticket contract-validate skill/references/tickets/contracts.unverified.json
```

生产契约保存于仓库外私有文件，用 XSY_TICKET_CONTRACTS 指定。结构校验通过不等于接口证据核验，不能简单把 unverified 改成 verified 宣称可用。不要提交凭据、真实记录或原始客户资料。

| 顶层项 | 内容 |
|---|---|
| version | 固定为1 |
| scope | 当前 API/CRM HTTPS origin、tenantId、可选subjectId；动作探测协议必需；内置创建另由计划绑定实时身份 |
| identity | api/crm身份读取协议及tenantPath/subjectPath，用于验证env Token和Cookie归属 |
| read | 已核验编号/日期字段、unix-ms编码及证据 |
| references | 客户、负责人、派工池、部门、业务类型、资产的已核验查询/选项及约束 |
| actions | 动作版本、证据、输入、请求、权限探测、预期影响与回读 |
| timeline | 来源名称与已核验关联查询，未核验来源可只登记名称 |
| fieldJobHistory | 原生三来源历史：parentObjectId与证据，需scope；活动/报告双父关联及流程任务历史 |
| download | 已核验GET下载及权限探测，默认20MiB、上限100MiB |

verified 动作通常必须有 scope/evidence/request/probe/verify。标准 create 的 authorization=server 可省略 probe/scope，但执行仍核验当前身份并绑定计划。证据记录 source=official、page或implementation、reference及带时区verifiedAt；implementation 表示复用已有实现的协议依据，不等于完成线上验收。synthetic仅能被测试代码显式加载，生产CLI/MCP拒绝。unsupported也需明确范围和证据，未查明时保持unverified。

输入由fields声明string/number/boolean/object/array及enum/min/max/required。required/defaults与当前表单探测结果合并；未知输入拒绝。create必须使用fieldMode=create，额外检查实际元数据可写性和对象级必填；ownerId/entityType不可通过普通更新改变。formPath下动态表单采用规范化 `{required,defaults,fields,version}`；页面响应若不符合此结构，需要增加经核验的表单解码适配，不能猜层级。

recordPreconditions 可声明记录字段的严格 JSON 值，例如 `[{"field":"customItem62__c","expected":1},{"field":"status","expected":1}]` 将本类型 submit 限于草稿/待处理。它们会自动读取、加入快照，并在 prepare、execute、capabilities 共同检查；缺失字段不等于 null，不符合条件的动作会被阻断。创建没有已有记录，不能声明这些条件。未声明该可选项的旧契约 hash 和快照保持兼容。

request支持本站API/CRM的GET/POST/PATCH与json/form/multipart。声明successPath/successValues、可选rejectValues、resultIdPath和outputPaths。路径仅支持站内路径，可用:id，下载另支持:attachmentId；不接受绝对URL、路径回退、跨站重定向或任意主表更新冒充生命周期动作。

模板以单键对象 `{"$ref":"input.reason"}` 引用input/target/context/record/result/operation/probe，不执行JS。operation.operationId 为本计划的操作号；probe 为探测响应中通过 outputPaths 声明投影的业务数据。result.id为返回资源ID，其余result字段来自请求outputPaths。未解析引用即失败。form需JSON编码的字段明确列入jsonFields；multipart明确fileField。必要的x-*及accept头可声明模板并在计划中冻结，认证凭据仍由现有管理器提供。

接口明确要求 JSON 整数 ID 时可使用 `{"$ref":"target.id","$type":"integer"}`。仅接受安全正整数或无损的十进制字符串；超出 JavaScript 安全整数范围、空白、小数和负值均拒绝，避免改变真实记录 ID。

probe必须是已核验读取协议，permissionPath和allowedPath仅在返回布尔true时判定允许。可选formPath用于动态表单；对象标记不能替代权限/动作探测。

需要组合任务权限和下一节点配置时，probe.reads 可追加最多5个 `{request,outputPaths}` 已核验读取。各请求顺序执行，可引用此前的 probe 投影；投影键不能重复或包含凭据字段。最终业务值与主探测一起冻结到计划，执行前重新读取，任一变化使原计划失效。未知副作用的预处理接口不能登记为只读探测。

引用解析采用 references 登记的范围和来源。示例：`xsy ticket resolve responsible --name "$ticket_engineer_name"`；重名返回候选并阻止自动选择。指定 --pool/--department 时必须有已核验约束；池成员可按用户解析后独立查询成员关系，不假定服务端支持引用 JOIN。解析结果 eligibility 保留 unknown，实际动作仍需实时权限/允许动作探测。prepare 可用 --references 提供显式 field/reference 绑定，不覆盖已有 input，同名或不可核验的约束不会产生可执行计划。

时间线可按 query.timeField 与 dateEncoding 的明确映射排序当前页；coverageScope 仅为配置来源，historyCompleteness 保留 unknown，不将某一个工时来源冒充完整远端审计历史。

verify.checks检查主表；可选query检查关联记录，additional增加必要联动检查。查询指定apiKey/fields/linkField，默认绑定工单ID，bind=result可绑定返回的报告/附件等资源ID。每组条件必须在同一行满足，全部组通过才verified。每来源最多回读100条，未命中维持pending。验证范围仅为登记的检查，不代表未配置的SLA、通知和外部同步已经验收。

## prepare、确认、执行与回查

```sh
xsy ticket prepare close --id "$ticket_id" --data '{"reason":"用户已明确确认的关闭原因"}'
# 审核ready计划的目标、payload、影响和指纹后，由用户或已授权调用方执行
xsy ticket execute "$ticket_plan_id" --confirm "$ticket_fingerprint" --confirmation-reference "$ticket_approval_reference"
xsy ticket operation "$ticket_operation_id"
xsy ticket operation "$ticket_operation_id" --reconcile
```

执行需显式配置XSY_TICKET_WRITES=1。交互终端缺--confirm时会展示计划并要求输入指纹；非交互调用直接返回缺少确认。--yes不能绕过确认，--dry-run ticket execute只展示已有计划。指纹用于一致性，不独立证明用户授权。开发接入授权不等于任意生产工单写入授权。

执行前复查身份、契约、元数据、表单与当前状态。当前并发语义为best_effort：不虚构ETag，本地互斥不能阻止网页或其他客户端并发改动。

状态目录默认 `~/.config/xiaoshouyi-cli/tickets/operations`，可配置XSY_TICKET_STATE_DIR；目录0700、文件0600。CLI/MCP共享目录才能共享本地单次发送控制。完整payload只在私有计划和prepare预览中保留，operation输出最小审计摘要。

已提交但回读失败保存applied_pending_verification；超时、断连、无法判定的写响应保存outcome_unknown，不盲目重发。dispatching进程中断后保留不确定性和旧执行锁。已有提交回执可回读恢复；没有回执时，可通过 recovery 契约查询写入时携带的唯一 operation.operationId，再按目标、结果和效果检查恢复。无匹配、多匹配或读取失败继续保留不确定；没有可靠服务端关联能力时记录人工核对结果。相似标题或当前状态相同不能证明本次操作已落地。本地操作号不等于服务器幂等，也不保证跨设备exactly-once。

recovery 包含已核验证据、apiKey、correlationField、resultIdField、可选targetField/outputFields及checks；写请求payload或业务头必须携带该 operationId，已有工单动作还必须校验目标。人工核对用 `ticket operation-review --data ... --preview` 预览规范化结论和reviewFingerprint，再确认该核对指纹；原计划指纹不能代替核对结论授权。applied仍需业务回读；not_applied为本操作终态，不能直接重发原计划；inconclusive保持未知。

## 扩展动作与附件

统一动作：create/submit/assign/reassign/accept/reply/pause/resume/escalate/resolve/complete/close/reopen/return/void/attachment_upload/attachment_link/worklog/report。submit 为独立的真实工作流提交。逐项登记真实协议，状态枚举不作为迁移图。

```sh
xsy ticket prepare attachment_upload --id "$ticket_id" --file "$ticket_file"
# 上传执行成功后，按真实返回句柄准备独立关联动作
xsy ticket prepare attachment_link --id "$ticket_id" --data "$ticket_link_payload"
xsy ticket attachment-download "$ticket_id" "$ticket_attachment_id" --output "$ticket_download_path"
xsy ticket prepare worklog --id "$ticket_id" --data "$ticket_worklog_payload"
xsy ticket prepare report --id "$ticket_id" --data "$ticket_report_payload"
```

上传准备只绑定本地文件哈希，最大20MiB；执行前及发送时复查。上传与关联分阶段确认，上传成功不代表已关联，关联失败不盲目重新上传。当前实现支持经核验的本站multipart协议；第三方对象存储、预签名上传或特殊表单需取得真实协议后追加适配。未实现时保持unverified。

## MCP宿主确认

默认提供检索、详情、能力、时间线、准备、回查和附件下载工具；本地计划、回查和下载可能写私有文件，注解如实标记。CRM执行工具默认不注册。

另提供 tickets_reference_resolve 与带 references 的 tickets_prepare。人工核对工具 tickets_operation_review 仅在宿主密钥配置后注册；它修改本地账本，必须签名确认具体核对内容。

XSY_TICKET_WRITES=1且XSY_TICKET_APPROVAL_SECRET至少32字节时注册tickets_execute。密钥仅交给可信宿主，不提供给模型或工具参数。

宿主核验用户已有授权或明确确认后，将JSON `{planId,fingerprint,expiresAt,approvedBy,reference}` 编码为base64url得到body，对body计算HMAC-SHA256(secret,body)并编码base64url得到signature，传入approval=body.signature。工具仅接受planId/fingerprint/approval，不接受新payload或confirmed:true。签名、范围、到期检查通过后仍校验当前状态和权限。

人工核对使用独立的 purpose=operation_review 签名，并绑定原计划与规范化核对内容的 reviewFingerprint；执行签名不能用于核对，核对签名也不能用于执行。结论、审核人、结果ID或证据任一改变都需新的核对确认。

核对签名body为 `{planId,fingerprint,purpose:"operation_review",reviewFingerprint,expiresAt,approvedBy,reference}`。其中planId为operationId，fingerprint是原计划指纹，reviewFingerprint为 `sha256:` 加规范化 `{purpose:"operation_review",planFingerprint,review}` 的SHA256。review先按代码的 normalizeOperationReview 规则校验；签名和传输编码方式与执行相同。MCP核对参数为 `{operationId,fingerprint,approval,review}`。快速只读桥会清空宿主密钥，不开放该本地账本修改工具。

## 真实CRM验收

2026-11-24 已原地复用 NeoCRM 登录态，验证 fieldJob 的162字段元数据、两页各3条查询及单记录详情；COUNT与COUNT DISTINCT均为43,169。NeoCRM枚举标签数组与REST原始数值经元数据对应后业务值一致。本次仅做有界读取和服务端聚合，没有全量导出。

后续仍需动作/表单/关联读取协议、用户级写权限、可观察副作用和明确授权的测试目标。读取成功不代表可以创建或流转；登记真实契约后，再按创建、分派、处理记录、解决、必要中间动作、关闭逐项回读验收。时间线、资产、附件、工时、报告和各分支单独验收。
