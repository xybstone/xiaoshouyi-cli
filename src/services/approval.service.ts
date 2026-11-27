// 审批服务 — 通过 CRM 域 creekflow 接口查询和处理审批

import axios from "axios";
import { getAuthManager } from "../auth/manager.js";
import { getCrmCookie } from "../api/crm-client.js";
import { CRM_BASE_URL, DEFAULT_TIMEOUT } from "../config.js";
import type { ApiResponse, QueryResult } from "../types/index.js";

// ---- 常量 ----

const CRM_REST_BASE = `${CRM_BASE_URL}/rest/data/v2.0/creekflow/approval`;

// ---- Types ----

interface CreekflowTaskRecord {
  id: string;
  name?: string;
  procName?: string;
  approvalStartUser?: { uid: number; name: string; departName: string };
  approvalCurUser?: { uid: number; name: string };
  approvalInstStatus?: number;
  status?: number;
  approvalObjectApiKey?: string;
  objectApikey?: string;
  approvalObjectId?: number;
  dataId?: string;
  approvalId?: string;
  insProcId?: string;
  taskDefKey?: string;
  [key: string]: unknown;
}

interface CreekflowQueryResponse {
  code: number | string;
  msg: string;
  data?: {
    records?: CreekflowTaskRecord[];
    pageCount?: number;
  };
}

// ---- 工具函数 ----

function getCrmHeaders() {
  const mgr = getAuthManager();
  const status = mgr.getStatus();
  // 从 cookie 中提取 c-user 作为 xsy-user-id
  let userId = process.env.XSY_USER_ID || "";
  if (!userId) {
    try {
      // 从 cookie 中解析
      const cookie = getCrmCookie() || "";
      const match = cookie.match(/c-user=(\d+)/);
      if (match) userId = match[1];
    } catch { /* ignore */ }
  }
  return {
    "Content-Type": "application/json",
    Accept: "application/json, text/plain, */*",
    "xsy-client-type": "web",
    "xsy-device": "3",
    "xsy-tenant-id": status.tenantId || "3222329668260181",
    "xsy-user-id": userId,
  };
}

async function getCookieOrThrow(): Promise<string> {
  const cookie = getCrmCookie();
  if (!cookie) {
    throw new Error("请先配置 CRM Cookie: xsy auth crm-cookie --auto");
  }
  return cookie;
}

// ---- 查询待审批 ----

/**
 * 查询审批待办列表
 * POST /rest/data/v2.0/creekflow/approval/flowTask/query
 */
export async function queryApprovalWorkItems(
  _statusFilter?: number,
  page = 1,
  size = 20,
): Promise<ApiResponse<QueryResult>> {
  try {
    const cookie = await getCookieOrThrow();

    const requestBody = {
      data: {
        viewEntityApiKey: "creekflowTask",
        dataViewApiKey: "approvalTask_view_pending",
        dataType: "new",
        pagesize: size,
        pagenum: page - 1,
        conditions: [],
        objectConditions: {
          conditions: [],
          toSearchColumns: [],
          sortorder: "",
          sortdatafield: "",
        },
        toSearchColumns: [],
      },
    };

    const response = await axios.post<CreekflowQueryResponse>(
      `${CRM_REST_BASE}/flowTask/query`,
      requestBody,
      {
        timeout: DEFAULT_TIMEOUT,
        headers: {
          Cookie: cookie,
          ...getCrmHeaders(),
        },
      }
    );

    const data = response.data;

    if (data.code !== 200 && data.code !== "200") {
      return {
        code: Number(data.code) || 500,
        msg: data.msg || "查询审批待办失败",
        result: { totalSize: 0, count: 0, records: [] },
      };
    }

    const records = data.data?.records || [];
    const mapped = records.map((r) => ({
      id: r.id,
      name: r.name || r.procName || "",
      processName: r.procName || "",
      applicantName: r.approvalStartUser?.name || "",
      applicantDept: r.approvalStartUser?.departName || "",
      approverName: r.approvalCurUser?.name || "",
      status: r.approvalInstStatus ?? r.status ?? "",
      objectApiKey: r.objectApikey || r.approvalObjectApiKey || "",
      objectId: String(r.approvalObjectId || ""),
      dataId: r.dataId || "",
      insProcId: r.insProcId || "",
      taskDefKey: r.taskDefKey || "",
    }));

    return {
      code: 200,
      msg: "操作成功",
      result: {
        totalSize: mapped.length,
        count: mapped.length,
        records: mapped,
      },
    };
  } catch (err) {
    // 处理 cookie 过期
    if (axios.isAxiosError(err) && err.response?.status === 401) {
      throw new Error("CRM Cookie 已过期，请重新设置: xsy auth crm-cookie --auto");
    }
    throw err;
  }
}

// ---- 审批详情 ----

export async function getApprovalWorkItem(
  id: string,
): Promise<ApiResponse> {
  try {
    const listResp = await queryApprovalWorkItems(0, 1, 100);
    const record = listResp.result?.records?.find((r: Record<string, unknown>) => r.id === id);

    if (!record) {
      return {
        code: 404,
        msg: "未找到该审批记录",
        result: null,
      };
    }

    return {
      code: 200,
      msg: "操作成功",
      result: record,
    };
  } catch (err) {
    throw err;
  }
}

// ---- 批准/驳回 ----

/**
 * 执行审批操作
 * POST /rest/data/v2.0/creekflow/approval/userTaskLog/{objectApiKey}
 */
export async function executeApprovalAction(
  id: string,
  action: "approve" | "reject",
  comment?: string,
): Promise<ApiResponse> {
  try {
    const cookie = await getCookieOrThrow();

    // 先查询获取该待办的完整信息
    const listResp = await queryApprovalWorkItems(0, 1, 100);
    const records = listResp.result?.records || [];
    const record = records.find((r: Record<string, unknown>) => r.id === id) as Record<string, unknown> | undefined;

    if (!record) {
      return {
        code: 404,
        msg: "未找到该审批待办，可能已被处理",
        result: null,
      };
    }

    const objectApiKey = record.objectApiKey as string;
    const dataId = record.dataId as string;
    const insProcId = record.insProcId as string;
    const taskDefKey = record.taskDefKey as string;

    if (!objectApiKey || !dataId) {
      return {
        code: 400,
        msg: "审批记录缺少必要字段（objectApiKey, dataId）",
        result: null,
      };
    }

    const requestBody = {
      data: {
        action: action === "approve" ? "agree" : "reject",
        procdefId: insProcId,
        nextTaskDefKey: null,
        usertaskLogId: id,
        nextUserTasks: [],
        ccs: [],
        comment: comment || "",
        operateApiKey: "",
        xObjectApiKey: objectApiKey,
        dataId,
        srcTaskDefKey: taskDefKey || null,
        srcProcInstId: null,
      },
    };

    const response = await axios.post(
      `${CRM_REST_BASE}/userTaskLog/${objectApiKey}`,
      requestBody,
      {
        timeout: DEFAULT_TIMEOUT,
        headers: {
          Cookie: cookie,
          ...getCrmHeaders(),
        },
      }
    );

    const result = response.data as Record<string, unknown>;
    const resultCode = result.code ?? result.status;

    if (resultCode === 200 || resultCode === "200" || resultCode === 0 || resultCode === "0") {
      return {
        code: 200,
        msg: action === "approve" ? "已批准" : "已驳回",
        result: result.data || result,
      };
    }

    return {
      code: Number(resultCode) || 500,
      msg: (result.msg as string) || (action === "approve" ? "审批失败" : "驳回失败"),
      result: result.data || null,
    };
  } catch (err) {
    if (axios.isAxiosError(err) && err.response?.status === 401) {
      throw new Error("CRM Cookie 已过期，请重新设置: xsy auth crm-cookie --auto");
    }
    throw err;
  }
}
