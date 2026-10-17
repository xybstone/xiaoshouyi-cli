import { getApiClient } from "./api/client.js";
import { getCrmFieldDictionary, getCrmObjectMetadata } from "./crm-knowledge.js";

type Tool = { name: string; description: string; inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] } };
interface QueryPage<T> { records: T[]; totalSize: number; count: number; }
interface QueryMeta { totalSize: number; returned: number; truncated: boolean; }
const tools: Tool[] = [
  { name: "sales_order_detail", description: "查询订单、报价单和报价单全部明细。只读。按订单号查询。", inputSchema: { type: "object", properties: { orderNo: { type: "string", description: "订单号，例如 JJSH20260929-005" } }, required: ["orderNo"] } },
  { name: "sales_hci_quote_details", description: "查询国内业务事业部、订单金额非负的一体机订单及其全部报价明细。可按订单号过滤。", inputSchema: { type: "object", properties: { orderNo: { type: "string", description: "可选订单号" }, limit: { type: "number", description: "最多返回订单数，默认20，最大100" } } } },
  { name: "sales_monthly_summary", description: "按签约月份统计国内业务事业部、非负金额的一体机订单金额、订单数和产品数量。全量分页。", inputSchema: { type: "object", properties: { start: { type: "string", description: "开始日期 YYYY-MM-DD，默认2025-03-01" }, end: { type: "string", description: "结束日期 YYYY-MM-DD（含当天），默认2027-02-28" } } } },
  { name: "sales_standard_pricebook", description: "查询销售易标准价格表明细，返回产品、规格型号、标准价、单位和生效状态。可按产品 ID过滤。", inputSchema: { type: "object", properties: { productId: { type: "string", description: "可选产品 ID" }, limit: { type: "number", description: "返回条数，默认100，最大100" } } } },
  { name: "sales_order_bom", description: "按订单号查询报价单全部报价行及 BOM/配置参数，包含整机硬件、软件授权、服务和报价价格。", inputSchema: { type: "object", properties: { orderNo: { type: "string", description: "订单号" } }, required: ["orderNo"] } },
  { name: "sales_crm_field_dictionary", description: "查询 xiaoshouyi-cli 内置的 CRM 关键字段字典、对象关系、枚举和分析口径。", inputSchema: { type: "object", properties: {} } },
  { name: "sales_crm_object_metadata", description: "查询 CRM 对象完整字段元数据、类型、标签、关联对象和枚举值。", inputSchema: { type: "object", properties: { apiKey: { type: "string", description: "对象 API Key，例如 order、orderProduct、quoteLine、product" } }, required: ["apiKey"] } },
];

function jsonRpc(id: unknown, result: unknown): void { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n"); }
function error(id: unknown, code: number, message: string): void { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n"); }
function sqlQuote(value: string): string { return `'${value.replaceAll("'", "''")}'`; }
function dayStart(value: string): number { const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value); if (!match) throw new Error(`日期格式无效: ${value}`); return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) - 8 * 3600_000; }
function dayEnd(value: string): number { return dayStart(value) + 24 * 3600_000; }

async function queryPage<T extends Record<string, unknown>>(sql: string): Promise<QueryPage<T>> {
  const response = await getApiClient().get<{ code: number; msg?: string; result?: { records: T[]; totalSize?: number; count?: number } }>("/rest/data/v2/query", { params: { q: sql } });
  if (response.data.code !== 200) throw new Error(response.data.msg ?? "销售易查询失败");
  const result = response.data.result ?? { records: [] };
  return { records: result.records ?? [], totalSize: result.totalSize ?? result.records?.length ?? 0, count: result.count ?? result.records?.length ?? 0 };
}

async function queryAll<T extends Record<string, unknown>>(sql: string, pageSize = 100): Promise<{ records: T[]; totalSize: number }> {
  const records: T[] = [];
  let totalSize = 0;
  for (let offset = 0; ; offset += pageSize) {
    const page = await queryPage<T>(`${sql} order by id limit ${offset},${pageSize}`);
    records.push(...page.records);
    totalSize = page.totalSize;
    if (page.records.length < pageSize || records.length >= totalSize) break;
  }
  return { records, totalSize };
}

function meta(totalSize: number, returned: number): QueryMeta { return { totalSize, returned, truncated: returned < totalSize }; }

const quoteLineFields = "id,quotationDetailEntityRelProduct,quantity,priceDomestic,amountDomestic,aggregatedPriceDomestic,aggregatedAmountDomestic,customItem1__c,customItem5__c,customItem21__c,customItem25__c,customItem26__c,customItem55__c,customItem56__c,customItem57__c";

async function orderDetail(orderNo: string): Promise<unknown> {
  const orders = await queryAll<Record<string, unknown>>(`select id,po,signDate__c,amount,initAmount,productsAmount,lineItemCount,isCube__c,customItem224__c,accountId,opportunityId,orderRelQuotationEntity,customItem428__c,customItem429__c,customItem430__c,customItem445__c from order where po = ${sqlQuote(orderNo)}`);
  if (!orders.records[0]) throw new Error(`订单不存在: ${orderNo}`);
  const order = orders.records[0];
  const quotationId = order.orderRelQuotationEntity;
  const quotes = quotationId ? await queryAll<Record<string, unknown>>(`select id,name,quotationAmountDomestic,listTotalDomestic,totalDiscountAmountDomestic,quotationQuantity,customItem59__c,customItem67__c from quote where id = ${quotationId}`) : { records: [], totalSize: 0 };
  const lines = quotationId ? await queryAll<Record<string, unknown>>(`select ${quoteLineFields} from quoteLine where quotationDetailEntityRelQuotationEntity = ${quotationId}`) : { records: [], totalSize: 0 };
  return { order, quote: quotes.records[0] ?? null, quoteLines: lines.records, meta: { orders: meta(orders.totalSize, orders.records.length), quotes: meta(quotes.totalSize, quotes.records.length), quoteLines: meta(lines.totalSize, lines.records.length) } };
}
async function orderReconciliation(orderNo: string): Promise<unknown> {
  const detail = await orderDetail(orderNo) as { order: Record<string, unknown>; quoteLines: Array<Record<string, unknown>>; quote: Record<string, unknown> | null };
  const orderId = detail.order.id;
  const orderProducts = await queryAll<Record<string, unknown>>(`select id,orderId,productId,quantity,priceTotal,customItem186__c,customItem190__c,customItem193__c,customItem215__c,customItem250__c,customItem257__c from orderProduct where orderId = ${orderId}`);
  const orderProductAmount = orderProducts.records.reduce((sum, row) => sum + Number(row.priceTotal ?? 0), 0);
  const quoteAmount = detail.quoteLines.reduce((sum, row) => sum + Number(row.amountDomestic ?? 0), 0);
  const positiveQuoteAmount = detail.quoteLines.reduce((sum, row) => { const amount = Number(row.amountDomestic ?? 0); return sum + (amount > 0 ? amount : 0); }, 0);
  const orderAmount = Number(detail.order.amount ?? 0);
  const diffs = { orderVsOrderProducts: orderAmount - orderProductAmount, orderVsQuoteLines: orderAmount - quoteAmount, orderVsPositiveQuoteLines: orderAmount - positiveQuoteAmount };
  const flags: string[] = [];
  if (Math.abs(diffs.orderVsOrderProducts) > 0.01) flags.push("订单主表与订单明细金额不一致");
  if (Math.abs(diffs.orderVsQuoteLines) > 0.01) flags.push("订单主表与报价行金额不一致");
  if (detail.quoteLines.length === 0) flags.push("没有报价行");
  if (detail.quoteLines.some(row => Number(row.amountDomestic ?? 0) === 0)) flags.push("包含零价报价行");
  return { order: detail.order, quote: detail.quote, orderProducts: orderProducts.records, quoteLines: detail.quoteLines, reconciliation: { orderAmount, orderProductAmount, quoteAmount, positiveQuoteAmount, diffs, flags, status: flags.length === 0 ? "一致" : "需要核对" } };
}


async function hciDetails(orderNo?: string, limit = 20): Promise<unknown> {
  const size = Math.min(Math.max(Math.trunc(limit), 1), 100);
  const where = `customItem428__c = '国内业务事业部' and amount >= 0 and isCube__c = true${orderNo ? ` and po = ${sqlQuote(orderNo)}` : ""}`;
  const allOrders = await queryAll<Record<string, unknown>>(`select id,po,signDate__c,amount,accountId,orderRelQuotationEntity,customItem428__c,customItem429__c,customItem430__c,customItem445__c from order where ${where}`);
  const orders = allOrders.records.slice(0, size);
  const result: unknown[] = [];
  for (const order of orders) {
    const quotationId = order.orderRelQuotationEntity;
    const lines = quotationId ? await queryAll<Record<string, unknown>>(`select ${quoteLineFields} from quoteLine where quotationDetailEntityRelQuotationEntity = ${quotationId}`) : { records: [], totalSize: 0 };
    result.push({ order, quotationId: quotationId ?? null, quoteLines: lines.records, meta: { quoteLines: meta(lines.totalSize, lines.records.length) } });
  }
  return { orders: result, meta: meta(allOrders.totalSize, orders.length) };
}

async function monthlySummary(start = "2025-03-01", end = "2027-02-28"): Promise<unknown> {
  const allOrders = await queryAll<Record<string, unknown>>(`select id,signDate__c,amount,productsAmount from order where customItem428__c = '国内业务事业部' and amount >= 0 and isCube__c = true and signDate__c >= ${dayStart(start)} and signDate__c < ${dayEnd(end)}`);
  const months = new Map<string, { month: string; orderCount: number; amount: number; productsAmount: number }>();
  for (const order of allOrders.records) {
    const month = new Date(Number(order.signDate__c) + 8 * 3600_000).toISOString().slice(0, 7);
    const row = months.get(month) ?? { month, orderCount: 0, amount: 0, productsAmount: 0 };
    row.orderCount += 1; row.amount += Number(order.amount ?? 0); row.productsAmount += Number(order.productsAmount ?? 0); months.set(month, row);
  }
  return { start, end, rows: [...months.values()].sort((a, b) => a.month.localeCompare(b.month)), meta: meta(allOrders.totalSize, allOrders.records.length) };
}
async function standardPricebook(productId?: string, limit = 100): Promise<unknown> {
  const size = Math.min(Math.max(Math.trunc(limit), 1), 100);
  const where = `priceBookId = 3222340301701443${productId ? ` and productId = ${productId}` : ""}`;
  const result = await queryAll<Record<string, unknown>>(`select id,priceBookId,productId,productPrice,bookPrice,productPriceDomestic,enableFlg,standardFlg,maintenanceStatus,fscProductModel,fscProductSpec,customItem23__c from priceBookEntry where ${where}`);
  return { priceBook: { id: 3222340301701443, name: "标准价格表" }, entries: result.records.slice(0, size), meta: meta(result.totalSize, Math.min(result.records.length, size)) };
}

async function orderBom(orderNo: string): Promise<unknown> { return orderDetail(orderNo); }

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> { if (name === "sales_order_detail") return orderDetail(String(args.orderNo)); if (name === "sales_hci_quote_details") return hciDetails(args.orderNo ? String(args.orderNo) : undefined, Number(args.limit ?? 20)); if (name === "sales_monthly_summary") return monthlySummary(String(args.start ?? "2025-03-01"), String(args.end ?? "2027-02-28")); if (name === "sales_standard_pricebook") return standardPricebook(args.productId ? String(args.productId) : undefined, Number(args.limit ?? 100)); if (name === "sales_order_bom") return orderBom(String(args.orderNo)); if (name === "sales_order_reconciliation") return orderReconciliation(String(args.orderNo)); if (name === "sales_crm_field_dictionary") return getCrmFieldDictionary(); if (name === "sales_crm_object_metadata") return getCrmObjectMetadata(String(args.apiKey)); throw new Error(`未知工具: ${name}`); }

async function main(): Promise<void> { let buffer = ""; process.stdin.setEncoding("utf8"); for await (const chunk of process.stdin) { buffer += chunk; let index = buffer.indexOf("\n"); while (index >= 0) { const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); index = buffer.indexOf("\n"); if (!line.trim()) continue; const request = JSON.parse(line) as { id?: unknown; method?: string; params?: { name?: string; arguments?: Record<string, unknown> } }; try { if (request.method === "initialize") jsonRpc(request.id, { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "xsy-sales", version: "0.2.0" } }); else if (request.method === "notifications/initialized") continue; else if (request.method === "tools/list") jsonRpc(request.id, { tools }); else if (request.method === "tools/call") jsonRpc(request.id, { content: [{ type: "text", text: JSON.stringify(await callTool(request.params?.name ?? "", request.params?.arguments ?? {}), null, 2) }] }); else if (request.id !== undefined) error(request.id, -32601, `不支持的方法: ${request.method ?? ""}`); } catch (err) { if (request.id !== undefined) error(request.id, -32000, err instanceof Error ? err.message : String(err)); } } } }
void main();
