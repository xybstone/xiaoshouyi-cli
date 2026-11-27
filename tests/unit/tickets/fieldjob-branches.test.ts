import { describe, expect, it } from "vitest";
import {
  fieldJobBranchPermissionEvidence,
  fieldJobBranchProtocolEvidence,
  fieldJobSideEffectEvidence,
  readFieldJobWorkflowPermission,
} from "../../../src/tickets/fieldjob-branches.js";

describe("工单分支与副作用证据边界", () => {
  it("读取真实嵌套布尔权限，不把动作对象或字符串当允许", () => {
    const response = { code: "200", data: { actions: {
      reopen: { permission: true }, pause: { permission: false },
      resume: { permission: "true" }, escalate: true,
    } } };
    expect(readFieldJobWorkflowPermission(response, "reopen")).toBe("allowed");
    expect(readFieldJobWorkflowPermission(response, "pause")).toBe("denied");
    expect(readFieldJobWorkflowPermission(response, "resume")).toBe("unknown");
    expect(readFieldJobWorkflowPermission(response, "escalate")).toBe("unknown");
    expect(readFieldJobWorkflowPermission(response, "void")).toBe("unknown");
  });
  it("业务错误或动作缺失保留未知，不冒充不支持或允许", () => {
    expect(readFieldJobWorkflowPermission({ code: 401, data: {
      actions: { reopen: { permission: true } },
    } }, "reopen")).toBe("unknown");
    expect(readFieldJobWorkflowPermission({ code: 200, data: {} }, "reopen")).toBe("unknown");
  });
  it("审批任务暂不处理、转交、拒绝、返程不自动成为业务分支", () => {
    const response = { code: 200, data: { actions: {
      taskSuspend: { permission: true }, taskUnsuspend: { permission: true },
      turn: { permission: true }, reject: { permission: true },
      returnedFieldJob: { permission: true },
    } } };
    expect(fieldJobBranchPermissionEvidence(response).every((item) =>
      item.permission === "unknown" && item.verification === "unverified" && !item.executable,
    )).toBe(true);
  });
  it("即使读到正权限，协议和副作用未验收仍不可执行", () => {
    const item = fieldJobBranchPermissionEvidence({ code: 200, data: {
      actions: { reopen: { permission: true } },
    } }).find((value) => value.action === "reopen")!;
    expect(item.permission).toBe("allowed");
    expect(item.verification).toBe("unverified");
    expect(item.executable).toBe(false);
  });
  it("公开暂停和恢复GET标注为mutation并禁止重放", () => {
    const evidence = fieldJobBranchProtocolEvidence();
    for (const item of evidence.filter((value) => ["pause", "resume"].includes(value.action))) {
      expect(item.pageProtocol).toMatchObject({ method: "GET", mutation: true, replay: "never" });
    }
    evidence[0].missingEvidence.length = 0;
    expect(fieldJobBranchProtocolEvidence()[0].missingEvidence.length).toBeGreaterThan(0);
  });
  it("结单状态不能掩盖缺失的实际时间或SLA日志", () => {
    expect(fieldJobSideEffectEvidence({ id: "1", status: 9, customItem62__c: 4,
      actualStartTime: null, actualEndTime: null, slaMatchTimes: 0,
    }, [])).toMatchObject({ actualStart: "missing", actualEnd: "missing",
      actualTimeCoverage: "unverified", slaLogEvidence: "not_observed",
      pauseSlaImpact: "unverified", notificationDelivery: "unverified" });
  });
  it("反向、非数值或零时间不作为有效起止时间", () => {
    expect(fieldJobSideEffectEvidence({ id: "1", actualStartTime: 20, actualEndTime: 10 }, [])
      .actualTimeOrderValid).toBe(false);
    expect(fieldJobSideEffectEvidence({ id: "1", actualStartTime: "20", actualEndTime: 0 }, []))
      .toMatchObject({ actualStart: "invalid", actualEnd: "invalid", actualTimeCoverage: "unverified" });
  });
  it("SLA日志必须关联同一工单；正日志仍不证明暂停计时或通知同步", () => {
    const evidence = fieldJobSideEffectEvidence({ id: "1", actualStartTime: 10, actualEndTime: 20,
      slaMatchTimes: 1,
    }, [{ id: "101", fieldJobId: { id: "1" } }, { id: "102", fieldJobId: "2" }]);
    expect(evidence).toMatchObject({ actualTimeCoverage: "observed", slaLogCount: 1,
      slaLogEvidence: "observed", pauseSlaImpact: "unverified",
      externalSynchronization: "unverified" });
  });
});
