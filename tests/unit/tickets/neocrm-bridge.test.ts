import { describe, expect, it } from "vitest";
import { validateReadOnlyArgs } from "../../../scripts/with-neocrm-session.mjs";

describe("NeoCRM 进程内凭据复用的只读边界", () => {
  it.each([
    ["ticket", "search", "--size", "3"],
    ["--fields", "id,status", "--timeout", "20", "ticket", "get", "1"],
    ["--format=json", "ticket", "capabilities", "--refresh"],
    ["ticket", "timeline", "1"],
    ["ticket", "resolve", "customer", "--name", "synthetic"],
  ])("允许明确的只读工单命令 %j", (...args) =>
    expect(validateReadOnlyArgs(args)).toEqual(args),
  );
  it.each([
    ["auth", "logout", "ticket", "search"],
    ["ticket", "execute", "plan"],
    ["ticket", "prepare", "close"],
    ["query", "UPDATE fieldJob"],
    ["--eval", "anything", "ticket", "search"],
    ["--fields", "id", "auth", "logout", "ticket", "search"],
  ])("拒绝非读取命令或伪装前缀 %j", (...args) =>
    expect(() => validateReadOnlyArgs(args)).toThrow(),
  );
});
