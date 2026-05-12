// format.test.ts — 响应格式化单元测试

import { describe, it, expect } from "vitest";
import { formatOutput } from "../../src/api/format.js";
import type { ApiResponse } from "../../src/types/index.js";

describe("formatOutput", () => {
  describe("json mode", () => {
    it("outputs success with {code, result}", () => {
      const resp: ApiResponse = { code: 200, msg: "操作成功", result: { id: 1, name: "test" } };
      const output = formatOutput(resp, { format: "json" });
      const parsed = JSON.parse(output);
      expect(parsed.code).toBe(200);
      expect(parsed.result).toEqual({ id: 1, name: "test" });
    });

    it("outputs error with {code, msg}", () => {
      const resp: ApiResponse = { code: 400, msg: "参数错误", result: null };
      const output = formatOutput(resp, { format: "json" });
      const parsed = JSON.parse(output);
      expect(parsed.code).toBe(400);
      expect(parsed.msg).toBe("参数错误");
      expect(parsed.result).toBeUndefined();
    });
  });

  describe("table mode", () => {
    it("formats query result with records", () => {
      const resp: ApiResponse = {
        code: 200,
        msg: "操作成功",
        result: {
          totalSize: 2,
          count: 2,
          records: [
            { id: "1", accountName: "销售易" },
            { id: "2", accountName: "华为" },
          ],
        },
      };
      const output = formatOutput(resp, { format: "table" });
      expect(output).toContain("| id | accountName |");
      expect(output).toContain("| 1  | 销售易      |");
      expect(output).toContain("(2 of 2 records)");
    });

    it("formats single record as table", () => {
      const resp: ApiResponse = {
        code: 200,
        msg: "操作成功",
        result: { id: 1, name: "test" },
      };
      const output = formatOutput(resp, { format: "table" });
      expect(output).toContain("| id | name |");
      expect(output).toContain("| 1  | test |");
    });

    it("formats arrays", () => {
      const resp: ApiResponse = {
        code: 200,
        msg: "操作成功",
        result: [{ key: "a", value: "1" }],
      };
      const output = formatOutput(resp, { format: "table" });
      expect(output).toContain("| key | value |");
    });

    it("returns string for non-object result", () => {
      const resp: ApiResponse = {
        code: 200,
        msg: "操作成功",
        result: "hello",
      };
      const output = formatOutput(resp, { format: "table" });
      expect(output).toBe("hello");
    });
  });

  describe("raw mode", () => {
    it("outputs string directly", () => {
      const resp: ApiResponse = {
        code: 200,
        msg: "操作成功",
        result: "plain text",
      };
      expect(formatOutput(resp, { format: "raw" })).toBe("plain text");
    });

    it("outputs array as newline-separated strings", () => {
      const resp: ApiResponse = {
        code: 200,
        msg: "操作成功",
        result: ["a", "b", "c"],
      };
      expect(formatOutput(resp, { format: "raw" })).toBe("a\nb\nc");
    });
  });

  describe("fields filter", () => {
    it("filters table output to specified fields", () => {
      const resp: ApiResponse = {
        code: 200,
        msg: "操作成功",
        result: { id: 1, name: "test", extra: "x" },
      };
      const output = formatOutput(resp, { format: "table", fields: ["id", "name"] });
      expect(output).toContain("| id | name |");
      expect(output).not.toContain("extra");
    });

    it("filters records table with fields", () => {
      const resp: ApiResponse = {
        code: 200,
        msg: "操作成功",
        result: {
          totalSize: 1,
          count: 1,
          records: [{ id: "1", name: "A", extra: "x" }],
        },
      };
      const output = formatOutput(resp, { format: "table", fields: ["id"] });
      expect(output).toContain("| id |");
      expect(output).not.toContain("name");
      expect(output).not.toContain("extra");
    });
  });
});
