# fieldJob 缺口补齐与真实验收（2026-11-27，北京时间）

本轮使用原 NeoCRM 隔离认证和原生 CLI，在测试客户下创建一张 `[CLI-LIFECYCLE-TEST] 2026-11-27 缺口验收` 工单。编号为 `20261127-00000016`。全部写入限于这张新单及其测试关联记录，没有修改原有业务工单，没有复制凭据，没有通过 Chrome 操作。

用户在本轮明确选择：继续只用现有 OAuth，需要网页会话的动作保留未验收；独立服务报告只做预检，不生成、不发送。

## 已通过真实验收

| 能力 | 实际证据 |
|---|---|
| 创建 | 返回新 ID，标题、初始状态回读匹配 |
| 专用派工 | 使用 `changeServiceTeamMember` 设置本人为主工程师；所有人、负责人、分配人、池，以及同一 `serviceTeam` 行的父工单、工程师、角色共8项回读通过；没有把流程路由当派工 |
| 独立活动记录 | 使用 `activity_record` 追加1条 CRM 活动记录；显式选择“国内跟进记录”类型，正文、部门、类型、发布时间、本人发布人、父对象类型与父工单均回读匹配；共享范围未核验，不称为客户回复 |
| 通用流程 | 实时发现任务及候选，按服务器允许动作执行 `submit → workflow_preprocess → advance → workflow_preprocess → close`；任务和候选没有写死在实现中 |
| 工时 | 追加1条0.5小时记录，记录 ID、父单、工程师、耗时及备注回读匹配 |
| 报告内容 | 仅补录 `problemReason__c`、`reportText__c`，字段回读匹配；这不是生成独立服务报告 |
| 结单 | 先取得明确的终结预处理证据，再执行真实流程动作；最终 `status=9`、`customItem62__c=4`，当前任务为空，允许动作为空；没有 PATCH 状态或阶段 |
| 时间线 | 实际读取1条活动记录及3条流程日志，参与人、时间、动作齐全；过滤1个未来节点占位。报告来源为0条，整体历史仍标 `partial`，不声称完整审计 |
| 独立报告预检 | CLI 正确识别所选模板0个附加表单、1条发送规则、1个实际收件邮箱，返回 `SERVICE_REPORT_DELIVERY_UNVERIFIED`；未生成或发送 |

核心验收 runner 的清单包含创建、提交、两次独立预处理、中间推进、工时、报告内容和结单，全部 `live_passed`。专用派工、活动记录及附件分别记录，不用核心清单成功替代其它能力验收。

## MCP真实只读验收

本轮另启动已构建的 `dist/mcp-server.js`，通过 stdio JSON-RPC 完成初始化、工具发现及真实CRM调用。协商协议为 `2025-06-18`，默认发现19个工具，其中11个工单工具；执行和人工核对工具均未开放。

对已关闭测试单依次调用 `tickets_search`（指定ID、1条、3个字段）、`tickets_get`（同3个字段）、`tickets_capabilities`（刷新）、`tickets_workflow`、`tickets_timeline`（最多10条）和 `tickets_service_report_preflight`，6项均成功返回。状态9、阶段4与CLI一致；时间线返回4条记录，仍如实标记partial；报告预检返回 `SERVICE_REPORT_DELIVERY_UNVERIFIED`，没有生成报告。本次MCP调用没有执行任何CRM写入。

客户端可将以下条目加入自己的 `mcpServers` 配置，使用本次已核验、默认不写CRM的运行范围：

```json
{
  "xsy-sales": {
    "command": "node",
    "args": ["/work/project/xiaoshouyi-cli/dist/mcp-server.js"],
    "env": {
      "XSY_NEOCRM_PROJECT": "/work/project/neocrm-cli-test",
      "XSY_ACCESS_TOKEN": "",
      "XSY_API_BASE_URL": "",
      "XSY_CRM_COOKIE": "",
      "XSY_TICKET_CONTRACTS": "/tmp/xsy-cli-gaps-20261127/runtime.json",
      "XSY_TICKET_STATE_DIR": "/tmp/xsy-cli-gaps-20261127/operations",
      "XSY_TICKET_WRITES": "",
      "XSY_TICKET_APPROVAL_SECRET": ""
    }
  }
}
```

该配置引用本机路径及本次测试范围的私有合同，不是通用生产配置；跨机器或长期部署前需配置各自凭据来源并归档私有合同和账本。`tickets_prepare` 可以生成本地计划，但本配置不会注册 `tickets_execute`。写入实现与CLI共用服务，签名校验已通过本地集成测试；当前客户端的用户确认与签名流程尚未接入，不能将CLI真实闭环视为MCP独立写入验收。

私有证据为 `/tmp/xsy-cli-gaps-20261127/mcp-live-read-summary.json` 及同目录 `mcp-live-read-transcript.json`，均为0600权限。

## 附件的准确边界

`POST /rest/file/v2.0/file/batch` 已实际接受测试文本，回执只含 `ext/fileName/fileUrl/fileLength`，不能强制要求同时存在预览、下载 URL 或文件 ID。独立读取该回执指定的 S3 对象时未发送 CRM Token/Cookie，66字节及 SHA-256 均与原文件匹配。

CLI 的 `attachment-download-upload --upload-only` 使用本地已确认、已验证的本人上传回执，仍复核当前身份和父工单读取权限，再从已核验的精确存储源下载。结果分别给出 `contentVerified` 和 `associationVerified`；此模式后者始终为false，不能用于宣称附件已关联。默认模式继续要求父工单附件关联正向回读。

页面字段保存的真实协议为：

```http
PATCH /rest/data/v2.0/xobjects/fieldJob/masterdetails
Content-Type: application/json

{"master":{"id":"<目标ID实际以安全整数编码>","customItem69__c":"<附件描述数组的JSON字符串>"}}
```

实现只允许 `master.id` 和该附件字段，不允许借此写状态、所有人、业务类型或子表。此专用保存请求已实际执行，关闭状态、阶段及原工时回读保持一致；附件字段仍未得到独立正向回读，账本保持 `applied_pending_verification`，不宣称关联成功。

SQL 对该 `doc` 字段返回 `null`，普通单记录 REST 响应省略该字段，两者都不能证明附件不存在。已按页面明确协议读取 `POST /rest/bff/v4.1/neoui/form/formInit`，同源 OAuth 返回 HTTP400、业务码 `1020008`、`passport not found`，没有取得页面附件数据。按用户选择，不导入网页会话，也不绕过认证。

首个上传在解码器修复前未保存原始回执，仍为 `outcome_unknown`，没有重传。后续使用不同名称和内容的独立文件验证修复。旧普通 `PATCH /:id` 关联协议不再作为当前协议，旧计划及失败回读保持原样；新主从保存合同使用新版本，不把旧账本改成成功。

## 已落实的执行保障

- 预处理是独立、明确确认、不可自动重放的动作；推进和结单只接受本地已验证、同身份、同工单、同任务且未过期的预处理操作。
- 实时候选变化、父记录变化或计划过期会在发送前阻断；本轮已实测过期提交计划被拒绝，再准备新计划执行。
- 同一已验证结单计划重复execute只返回既有结果；本轮仪表记录的Axios业务请求为0，没有再次关闭。
- HTTP状态及业务响应在成功码和字段解码前先写私有回执证据；绑定计划指纹、账号、动作、目标和合同，原子发布、不可覆盖、脱敏并限制大小。
- 数值和字符串形式的成功码正确归一化。已有可信响应的附件解码异常可以只读恢复；没有回执仍保留不确定，不根据当前字段相同推断本次写入成功。
- 验收 runner 默认 dry-run，每次仅执行当前明确确认的一个计划；可采用同一身份下已经验证的创建操作，完整核对输入和标题，禁止接管任意旧工单。

## 仍未验收的范围

转派、领取、暂停、恢复、升级、重开、业务退回、作废、客户回复、其它业务类型与角色仍需各自的真实权限、协议和验收。已核验的旧业务读取接口在当前 OAuth 下返回登录跳转，保留准确的未验收状态；审批暂不处理不映射为业务暂停，工程师返程不映射为工单退回。

最终实际起止时间仍为空，SLA命中计数为0；流程结束不证明SLA、通知或外部同步已经成立。独立服务报告不生成、不发送；没有修改模板或全局配置来避开这些边界。

## 使用与证据

```sh
export XSY_NEOCRM_PROJECT=/work/project/neocrm-cli-test
export XSY_TICKET_CONTRACTS=/tmp/xsy-cli-gaps-20261127/runtime.json
export XSY_TICKET_STATE_DIR=/tmp/xsy-cli-gaps-20261127/operations

node dist/cli.js ticket workflow "$ticket_id" --include-submit-chooser
node dist/cli.js ticket timeline "$ticket_id"
node dist/cli.js ticket service-report-preflight "$ticket_id" --template-name '通用派工报告(示例)'
node dist/cli.js ticket attachment-download-upload "$upload_operation_id" --upload-only --output "$private_output_path"
node scripts/ticket-live-acceptance.mjs --help
```

该私有运行合同限定本次账号、业务类型及必要测试目标，不应直接用于其它工单；源码工厂支持为已核验的新范围生成合同。已结束测试单仅用于读取，不再次运行清单创建或流转。

原始 payload、账本、HTTP业务回执、runner checkpoint和脱敏摘要位于 `/tmp/xsy-cli-gaps-20261127/`；目录0700、业务文件0600。真实内部ID、完整业务响应、报告收件信息与文件URL没有写入仓库。`/tmp` 是本次验收证据位置，需要长期保留时应以相同权限归档。

本地验证结果：41个测试文件、907项测试通过；类型检查、CLI/MCP构建通过。冒烟中的旧动作清单同步至当前23种动作后，CLI/MCP冒烟检查通过；默认仍只内置创建，未配置的动作继续为unverified。上述本地测试使用合成服务和假Token，不替代本文分别列出的真实验收结果。
