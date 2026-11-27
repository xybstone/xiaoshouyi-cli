import { Command } from "commander";
import { input as promptInput } from "@inquirer/prompts";
import {
  createTicketService,
  operationSummary,
} from "../services/ticket.service.js";
import {
  ContractRegistry,
  ticketContractSchema,
} from "../tickets/contracts.js";
import { formatOutput } from "../api/format.js";
import { classifyError } from "../api/errors.js";
import { referenceInputSchema } from "../tickets/references.js";
import { normalizeOperationReview, operationReviewFingerprint } from "../tickets/actions.js";
import {
  ACTIONS,
  TicketError,
  fail,
  object,
  parseInput,
  type RecordData,
} from "../tickets/types.js";

function opts(command: Command): RecordData {
  return command.optsWithGlobals() as RecordData;
}
function ticketService(command: Command) {
  return createTicketService({
    timeout: Number(opts(command).timeout ?? 30) * 1000,
  });
}
function fields(value: unknown): string[] | undefined {
  return typeof value === "string"
    ? value
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;
}
function json(value: unknown): RecordData {
  try {
    const data = JSON.parse(String(value ?? "{}"));
    if (!data || typeof data !== "object" || Array.isArray(data))
      fail("VALIDATION_FAILED", "--data 必须为 JSON 对象");
    return data as RecordData;
  } catch (error) {
    if (error instanceof TicketError) throw error;
    fail("VALIDATION_FAILED", "--data 不是合法 JSON");
  }
}
function arrayJson(value: unknown): unknown[] | undefined {
  if (value === undefined) return undefined;
  try {
    const data: unknown = JSON.parse(String(value));
    if (!Array.isArray(data)) fail("VALIDATION_FAILED", "--references 必须为 JSON 数组");
    return data;
  } catch (error) {
    if (error instanceof TicketError) throw error;
    fail("VALIDATION_FAILED", "--references 不是合法 JSON 数组");
  }
}
async function run(
  command: Command,
  fn: () => Promise<unknown>,
  options: { executing?: boolean } = {},
): Promise<void> {
  try {
    const result = await fn();
    const outcome = object(result);
    if (outcome.status === "blocked") {
      console.error(JSON.stringify(outcome));
      process.exitCode = 1;
      return;
    }
    if (options.executing && outcome.dryRun !== true && outcome.state !== "verified") {
      const state = String(outcome.state ?? "invalid_response");
      const rejected = ["rejected", "not_applied"].includes(state);
      const pending = state === "applied_pending_verification";
      const unknown = ["outcome_unknown", "dispatching"].includes(state);
      const fallback = rejected
        ? state === "rejected" ? "REMOTE_REJECTED" : "NOT_APPLIED"
        : pending ? "VERIFICATION_PENDING"
        : unknown ? "OUTCOME_UNKNOWN" : "OPERATION_INCOMPLETE";
      console.error(JSON.stringify({
        status: rejected ? state : pending ? "pending" : unknown ? "outcome_unknown" : "incomplete",
        code: typeof outcome.errorCode === "string" ? outcome.errorCode : fallback,
        message: rejected
          ? "该操作未成功落地；已保留操作记录，没有自动重新提交。"
          : pending
            ? "该操作尚未完成业务回读验证；请只读回查，不要重新提交。"
            : "目前无法确认该操作已经完成；请保留操作编号并只读回查，不要重新提交。",
        operation: outcome,
        next: {
          command: `xsy ticket operation ${String(outcome.operationId ?? outcome.planId ?? "<operationId>")} --reconcile`,
          crmWrite: false,
        },
      }));
      process.exitCode = rejected ? 1 : pending ? 3 : 2;
      return;
    }
    const o = opts(command);
    console.log(
      formatOutput(
        { code: 200, msg: "操作成功", result },
        {
          format:
            o.format === "table" || o.format === "raw" ? o.format : "json",
          fields: fields(o.fields),
        },
      ),
    );
  } catch (error) {
    const e = classifyError(error);
    console.error(
      JSON.stringify({
        status: "error",
        code: error instanceof TicketError ? error.code : e.name,
        message: e.message,
        details: error instanceof TicketError ? error.details : undefined,
      }),
    );
    process.exitCode = 1;
  }
}
export function registerTicketCommands(parent: Command): void {
  const ticket = parent
    .command("ticket")
    .description("fieldJob 技服工单查询与已核验生命周期动作");
  ticket
    .command("search")
    .description("受控分页检索工单")
    .option("--id <id>", "记录 ID")
    .option("--number <number>", "业务编号（字段需核验）")
    .option("--keyword <prefix>", "标题前缀")
    .option("--customer <id>", "客户 ID")
    .option("--responsible <id>", "负责人 ID")
    .option("--entity-type <id>", "业务类型 ID")
    .option("--status <values>", "原始状态值，逗号分隔")
    .option("--priority <values>", "原始优先级值，逗号分隔")
    .option("--since <iso>", "含时区的开始时间（包含）")
    .option("--until <iso>", "含时区的结束时间（不包含）")
    .option("--page <n>", "页码", "1")
    .option("--size <n>", "每页条数，最大100", "20")
    .option("--order <direction>", "id 排序方向", "desc")
    .action(async (_local, command: Command) =>
      run(command, async () => {
        const o = opts(command);
        return ticketService(command).search({
          id: o.id as string | undefined,
          number: o.number as string | undefined,
          keyword: o.keyword as string | undefined,
          customerId: o.customer as string | undefined,
          responsibleId: o.responsible as string | undefined,
          entityType: o.entityType as string | undefined,
          status: fields(o.status),
          priority: fields(o.priority),
          since: o.since as string | undefined,
          until: o.until as string | undefined,
          page: Number(o.page),
          size: Number(o.size),
          order: o.order as "asc" | "desc",
          fields: fields(o.fields),
        });
      }),
    );
  ticket
    .command("get")
    .description("读取明确字段的工单详情")
    .argument("<id>")
    .option("--include-context", "按需读取客户上下文，未核验资产关系明确标出")
    .action(async (id: string, _local, command: Command) =>
      run(command, () =>
        ticketService(command).get(
          id,
          fields(opts(command).fields),
          opts(command).includeContext === true,
        ),
      ),
    );
  ticket
    .command("capabilities")
    .description("默认离线报告；指定 ID 时核验记录读取与已登记动作")
    .argument("[id]")
    .option("--refresh", "刷新实际元数据")
    .action(async (id: string | undefined, _local, command: Command) =>
      run(command, () =>
        ticketService(command).capabilities({
          id,
          refresh: opts(command).refresh === true,
        }),
      ),
    );
  ticket
    .command("workflow")
    .description("只读发现当前流程任务与服务器允许动作；可读取提交候选")
    .argument("<id>")
    .option("--include-submit-chooser", "读取服务器提交节点与候选处理人")
    .action(async (id: string, _local, command: Command) =>
      run(command, () => ticketService(command).workflow(id, opts(command).includeSubmitChooser === true)),
    );
  ticket
    .command("timeline")
    .argument("<id>")
    .option("--page <n>", "页码", "1")
    .option("--size <n>", "每来源条数", "20")
    .action(async (id: string, _local, command: Command) =>
      run(command, () =>
        ticketService(command).timeline(
          id,
          Number(opts(command).page),
          Number(opts(command).size),
        ),
      ),
    );
  ticket
    .command("service-report-preflight")
    .description("只读核验独立服务报告模板、表单和外发配置；不生成或发送")
    .argument("<id>")
    .option("--template-id <id>", "明确选择模板ID")
    .option("--template-name <name>", "明确选择模板精确名称")
    .action(async (id: string, _local, command: Command) =>
      run(command, () => ticketService(command).serviceReportPreflight(id, {
        id: opts(command).templateId as string | undefined,
        name: opts(command).templateName as string | undefined,
      })),
    );
  ticket
    .command("resolve")
    .description("按已核验引用契约解析名称或ID；同名返回候选，不默认选择")
    .argument("<kind>", "customer/responsible/pool/department/entityType/asset")
    .option("--id <id>", "明确引用 ID")
    .option("--name <name>", "精确名称")
    .option("--pool <id>", "经核验的派工池约束")
    .option("--department <id>", "经核验的部门约束")
    .option("--limit <n>", "最多候选数，上限20", "10")
    .action(async (kind: string, _local, command: Command) =>
      run(command, () => {
        const o = opts(command);
        const input = parseInput(referenceInputSchema, { kind, id: o.id, name: o.name,
          poolId: o.pool, departmentId: o.department, limit: Number(o.limit) });
        return ticketService(command).resolveReference(input);
      }),
    );
  ticket
    .command("prepare")
    .description(`准备动作：${ACTIONS.join(", ")}；不写 CRM`)
    .argument("<action>")
    .option("--id <id>", "目标工单")
    .option("--data <json>", "已核验动作输入", "{}")
    .option("--references <json>", "明确字段及引用选择的绑定数组；多候选阻止准备")
    .option("--file <path>", "上传文件，仅绑定哈希")
    .option("--ttl <seconds>", "计划有效期，30至3600秒", "300")
    .action(async (action: string, _local, command: Command) =>
      run(command, () => {
        const o = opts(command);
        const data = json(o.data);
        if (o.file) data.filePath = String(o.file);
        return ticketService(command).prepare({
          action,
          id: o.id,
          input: data,
          references: arrayJson(o.references),
          ttlSeconds: Number(o.ttl),
        });
      }),
    );
  ticket
    .command("execute")
    .description("执行已确认计划；需要显式启用工单写入")
    .argument("<planId>")
    .option("--confirm <fingerprint>", "对该计划的明确确认指纹")
    .option("--confirmation-reference <reference>", "确认来源或授权记录")
    .action(async (planId: string, _local, command: Command) =>
      run(command, async () => {
        const o = opts(command);
        const service = ticketService(command);
        if (o.dryRun)
          return { dryRun: true, operation: await service.operation(planId) };
        let confirmed = typeof o.confirm === "string" ? o.confirm : undefined;
        if (!confirmed) {
          if (!process.stdin.isTTY)
            fail(
              "CONFIRMATION_REQUIRED",
              "非交互执行必须提供已授权计划的 --confirm 指纹",
            );
          const operation = await service.operation(planId);
          console.error(JSON.stringify(operation.plan, null, 2));
          confirmed = await promptInput({
            message: "确认具体目标与最终 payload 后输入该计划指纹：",
          });
        }
        return operationSummary(
          await service.execute(planId, {
            fingerprint: confirmed,
            source: "cli",
            reference: String(
              o.confirmationReference ?? "explicit CLI confirmation",
            ),
          }),
        );
      }, { executing: true }),
    );
  ticket
    .command("operation")
    .description("回查操作，不重放写入")
    .argument("<operationId>")
    .option("--reconcile", "回读 CRM 验证已提交操作")
    .action(async (id: string, _local, command: Command) =>
      run(command, async () =>
        operationSummary(
          await ticketService(command).operation(
            id,
            opts(command).reconcile === true,
          ),
        ),
      ),
    );
  ticket
    .command("operation-review")
    .description("记录人工核对结果及证据；只改本地账本，不能重发CRM写入")
    .argument("<operationId>")
    .requiredOption("--data <json>", "outcome/reviewedBy/evidenceReferences/resultId 核对结果")
    .option("--preview", "只展示规范化核对内容与其确认指纹，不修改账本")
    .option("--confirm <reviewFingerprint>", "确认具体人工核对内容的指纹，不能使用原计划指纹")
    .option("--confirmation-reference <reference>", "本次核对的明确授权来源")
    .action(async (id: string, _local, command: Command) =>
      run(command, async () => {
        const o = opts(command);
        const service = ticketService(command);
        const operation = await service.operation(id);
        const review = normalizeOperationReview(json(o.data));
        const reviewFingerprint = operationReviewFingerprint(operation.plan.fingerprint, review);
        const preview = { operationId: id, purpose: "operation_review", planFingerprint: operation.plan.fingerprint,
          review, reviewFingerprint, effects: "仅记录本地人工核对结论；已落地结论仍需业务回读，不重发写入" };
        if (o.preview || o.dryRun) return preview;
        let confirmed = typeof o.confirm === "string" ? o.confirm : undefined;
        if (!confirmed) {
          if (!process.stdin.isTTY)
            fail("CONFIRMATION_REQUIRED", "先用 --preview 核对内容，再以 --confirm 提供该人工核对指纹");
          console.error(JSON.stringify(preview, null, 2));
          confirmed = await promptInput({ message: "确认本次核对结论、结果ID、审核人和证据后，输入其reviewFingerprint：" });
        }
        if (typeof o.confirmationReference !== "string" || !o.confirmationReference.trim())
          fail("CONFIRMATION_REQUIRED", "人工核对需 --confirmation-reference 记录本次明确授权来源");
        return operationSummary(await service.review(id, {
          fingerprint: operation.plan.fingerprint, purpose: "operation_review", reviewFingerprint: confirmed,
          source: "cli", reference: o.confirmationReference,
        }, review));
      }),
    );
  ticket
    .command("attachment-download")
    .description("下载经核验且有权读取的附件")
    .argument("<id>")
    .argument("<attachmentId>")
    .option("--output <path>", "私有输出文件；不覆盖现有文件")
    .action(
      async (id: string, attachmentId: string, _local, command: Command) =>
        run(command, () =>
          ticketService(command).download(
            id,
            attachmentId,
            object(opts(command)).output as string | undefined,
          ),
        ),
    );
  ticket
    .command("attachment-download-upload")
    .description("从已核验的上传操作下载已关联文件，并核对原内容哈希")
    .argument("<uploadOperationId>")
    .option("--output <path>", "私有输出文件；不覆盖现有文件")
    .option("--upload-only", "仅核验本人已上传文件的内容，不证明工单关联")
    .action(async (id: string, _local, command: Command) =>
      run(command, () => ticketService(command).downloadUploadedAttachment(id, opts(command).output as string | undefined, opts(command).uploadOnly !== true)),
    );
  ticket
    .command("contract-schema")
    .description("输出工单契约文件的 JSON Schema，不访问 CRM")
    .action(async (_local, command: Command) =>
      run(command, async () => ticketContractSchema()),
    );
  ticket
    .command("contract-validate")
    .description("本地验证真实工单契约配置；不接受合成证据，不访问 CRM")
    .argument("<file>")
    .action(async (file: string, _local, command: Command) =>
      run(command, async () => {
        const registry = ContractRegistry.load(file);
        return {
          valid: true,
          version: registry.config.version,
          actions: registry.config.actions.map((c) => ({
            action: c.action,
            verification: c.verification,
            version: c.version,
          })),
        };
      }),
    );
}
