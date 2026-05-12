// utils.test.ts — 工具函数单元测试

import { describe, it, expect } from "vitest";
import {
  buildListQuery,
  buildSearchQuery,
  escapeSql,
  charWidth,
  formatTable,
  paginateResults,
} from "../../src/utils/index.js";

describe("escapeSql", () => {
  it("escapes single quotes", () => {
    expect(escapeSql("it's")).toBe("it''s");
  });

  it("passes normal strings through", () => {
    expect(escapeSql("hello")).toBe("hello");
  });

  it("handles empty string", () => {
    expect(escapeSql("")).toBe("");
  });
});

describe("buildListQuery", () => {
  it("builds simple list query", () => {
    const sql = buildListQuery("account", ["id", "accountName"], { offset: 0, size: 20 });
    expect(sql).toBe("select id,accountName from account limit 0,20");
  });

  it("adds where clause", () => {
    const sql = buildListQuery("account", ["id"], { where: "industry = 'IT'" });
    expect(sql).toBe("select id from account where industry = 'IT'");
  });

  it("adds order by", () => {
    const sql = buildListQuery("account", ["id", "accountName"], { order: "id desc" });
    expect(sql).toBe("select id,accountName from account order by id desc");
  });

  it("combines all clauses", () => {
    const sql = buildListQuery("opportunity", ["id", "opportunityName"], {
      where: "stage != '已关闭'",
      order: "id desc",
      offset: 0,
      size: 10,
    });
    expect(sql).toBe(
      "select id,opportunityName from opportunity where stage != '已关闭' order by id desc limit 0,10"
    );
  });

  it("defaults size to 20 when offset defined but size not", () => {
    const sql = buildListQuery("account", ["id"], { offset: 10 });
    expect(sql).toBe("select id from account limit 10,20");
  });
});

describe("buildSearchQuery", () => {
  it("builds search with like", () => {
    const sql = buildSearchQuery("account", ["id", "accountName"], "华", ["accountName"]);
    expect(sql).toBe("select id,accountName from account where accountName like '华%'");
  });

  it("searches across multiple fields", () => {
    const sql = buildSearchQuery("account", ["id", "accountName", "phone"], "test", [
      "accountName",
      "phone",
    ]);
    expect(sql).toBe(
      "select id,accountName,phone from account where accountName like 'test%' or phone like 'test%'"
    );
  });

  it("escapes quotes in keyword", () => {
    const sql = buildSearchQuery("account", ["id"], "it's", ["accountName"]);
    expect(sql).toBe("select id from account where accountName like 'it''s%'");
  });
});

describe("charWidth", () => {
  it("counts ASCII as 1", () => {
    expect(charWidth("abc")).toBe(3);
  });

  it("counts CJK as 2", () => {
    expect(charWidth("销售易")).toBe(6);
  });

  it("counts mixed", () => {
    expect(charWidth("abc销售易")).toBe(9); // 3 + 6
  });

  it("handles empty string", () => {
    expect(charWidth("")).toBe(0);
  });
});

describe("paginateResults", () => {
  const items = ["a", "b", "c", "d", "e", "f", "g", "h"];

  it("returns first page", () => {
    const page = paginateResults(items, 1, 3);
    expect(page.data).toEqual(["a", "b", "c"]);
    expect(page.hasMore).toBe(true);
    expect(page.total).toBe(8);
    expect(page.page).toBe(1);
  });

  it("returns last page", () => {
    const page = paginateResults(items, 3, 3);
    expect(page.data).toEqual(["g", "h"]);
    expect(page.hasMore).toBe(false);
  });

  it("returns empty for page beyond range", () => {
    const page = paginateResults(items, 10, 3);
    expect(page.data).toEqual([]);
    expect(page.hasMore).toBe(false);
  });
});

describe("formatTable", () => {
  it("returns (empty) for no rows", () => {
    expect(formatTable([])).toBe("(empty)");
  });

  it("formats single row", () => {
    const result = formatTable([{ id: "1", name: "test" }]);
    expect(result).toContain("| id | name |");
    expect(result).toContain("| 1  | test |");
  });

  it("formats multiple rows", () => {
    const result = formatTable([
      { id: "1", name: "Alice" },
      { id: "2", name: "Bob" },
    ]);
    const lines = result.split("\n");
    expect(lines[0]).toBe("| id | name  |");
    expect(lines[1]).toContain("---");
    expect(lines[2]).toBe("| 1  | Alice |");
    expect(lines[3]).toBe("| 2  | Bob   |");
  });

  it("pads CJK content correctly", () => {
    const result = formatTable([{ id: "1", name: "销售易" }]);
    // "销售易" has width 6, "name" has width 4 → name column width = 6
    const lines = result.split("\n");
    expect(lines[0]).toContain("name");
    expect(lines[2]).toContain("销售易");
  });
});
