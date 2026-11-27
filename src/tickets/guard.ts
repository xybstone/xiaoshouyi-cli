import { fail } from "./types.js";

// fieldJob 的流程写入只能经已登记动作执行器；普通对象不受影响。
export function guardObjectWrite(apiKey: string): void {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(apiKey))
    fail("VALIDATION_FAILED", "无效对象 API Key");
  if (apiKey.toLowerCase() === "fieldjob")
    fail(
      "TICKET_ACTION_REQUIRED",
      "fieldJob 写入请使用 xsy ticket prepare/execute，不能通过通用 CRUD 绕过流程",
    );
}
