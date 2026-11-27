import { describe, expect, it } from "vitest";
import { template } from "../../../src/tickets/contracts.js";

describe("模板引用的安全正整数转换", () => {
  it.each([1, 42, Number.MAX_SAFE_INTEGER, "1", "42", String(Number.MAX_SAFE_INTEGER)])(
    "无损转换合法正整数 %j", (id) => {
      expect(template({ $ref: "target.id", $type: "integer" }, { target: { id } })).toBe(Number(id));
    },
  );
  it.each([
    "", " ", " 1", "1 ", "01", "+1", "-1", "0", "1.0", "1.5", "1e3", "0x10",
    "9007199254740992", "9007199254740993", 0, -1, 1.5, NaN, Infinity,
    Number.MAX_SAFE_INTEGER + 1, true, false, null, undefined, {}, [],
  ])("拒绝不安全或非正整数 %j", (id) => {
    expect(() => template({ $ref: "target.id", $type: "integer" }, { target: { id } })).toThrow();
  });
  it("保留普通模板引用的数据类型，转换仅作用于明确声明的位置", () => {
    expect(template({
      original: { $ref: "target.id" },
      data: [{ $ref: "probe.procdefId", $type: "integer" }],
    }, { target: { id: "42" }, probe: { procdefId: "17" } })).toEqual({ original: "42", data: [17] });
  });
  it.each([
    { $ref: "process.env.SECRET", $type: "integer" },
    { $ref: "target.constructor", $type: "integer" },
    { $ref: "target.id", $type: "number" },
    { $ref: "target.id", $type: "integer", fallback: 1 },
    { $ref: 1, $type: "integer" },
  ])("类型转换不能扩大模板语法或引用范围 %j", (value) => {
    expect(() => template(value, { target: { id: "42" } })).toThrow();
  });
});
