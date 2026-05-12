// errors.test.ts — 错误分类单元测试

import { describe, it, expect } from "vitest";
import { classifyError, AuthError, ApiError, NetworkError, XsyError } from "../../src/api/errors.js";

describe("classifyError", () => {
  it("returns same XsyError if already one", () => {
    const authErr = new AuthError();
    expect(classifyError(authErr)).toBe(authErr);
  });

  it("classifies 401 as AuthError", () => {
    const axiosErr = createAxiosError(401);
    const result = classifyError(axiosErr);
    expect(result).toBeInstanceOf(AuthError);
  });

  it("classifies 403 as AuthError", () => {
    const axiosErr = createAxiosError(403);
    const result = classifyError(axiosErr);
    expect(result).toBeInstanceOf(AuthError);
  });

  it("classifies API error response as ApiError", () => {
    const axiosErr = createAxiosError(400, { code: 400, msg: "参数错误" });
    const result = classifyError(axiosErr);
    expect(result).toBeInstanceOf(ApiError);
    expect((result as ApiError).code).toBe(400);
    expect(result.message).toBe("参数错误");
  });

  it("handles both msg and message in response data", () => {
    const axiosErr = createAxiosError(400, { code: 400, message: "Bad request" });
    const result = classifyError(axiosErr);
    expect(result).toBeInstanceOf(ApiError);
    expect(result.message).toBe("Bad request");
  });

  it("classifies ECONNABORTED as NetworkError timeout", () => {
    const err = new Error("timeout");
    const axiosErr = { isAxiosError: true, code: "ECONNABORTED" };
    const result = classifyError(axiosErr);
    expect(result).toBeInstanceOf(NetworkError);
    expect(result.message).toContain("超时");
  });

  it("classifies ENOTFOUND as NetworkError", () => {
    const axiosErr = { isAxiosError: true, code: "ENOTFOUND" };
    const result = classifyError(axiosErr);
    expect(result).toBeInstanceOf(NetworkError);
    expect(result.message).toContain("无法连接");
  });

  it("classifies ECONNREFUSED as NetworkError", () => {
    const axiosErr = { isAxiosError: true, code: "ECONNREFUSED" };
    const result = classifyError(axiosErr);
    expect(result).toBeInstanceOf(NetworkError);
    expect(result.message).toContain("无法连接");
  });

  it("wraps regular Error in XsyError", () => {
    const err = new Error("something broke");
    const result = classifyError(err);
    expect(result).toBeInstanceOf(XsyError);
    expect(result.message).toBe("something broke");
  });

  it("wraps string in XsyError", () => {
    const result = classifyError("plain error");
    expect(result).toBeInstanceOf(XsyError);
    expect(result.message).toBe("plain error");
  });
});

// helpers
function createAxiosError(status: number, data?: Record<string, unknown>) {
  return {
    isAxiosError: true,
    response: {
      status,
      data,
    },
  };
}
