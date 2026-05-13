// CRM 域客户端 — 调用 crm.xiaoshouyi.com 的 Java action 接口
// 用于获取跟进记录等 REST API 禁用的对象

import fs from "node:fs";
import axios from "axios";
import { CRM_BASE_URL, CRM_COOKIE_FILE, DEFAULT_TIMEOUT } from "../config.js";
import type { ApiResponse, QueryResult } from "../types/index.js";

// CRM 活动记录项
interface CrmActivityRecord {
  id: number;
  name: string;
  content?: string;
  createdAt: number;
  updatedAt: number;
  ownerId: number;
  fromBelongName?: string;
  from?: { name: string; belongId: number; id: number; objectApiKey?: string };
}

// CRM 活动记录列表响应
interface CrmActivityResponse {
  status: number;
  statusText: string;
  data: {
    userList: unknown[];
    commentCountMap: Record<string, number>;
    dataImgMap: Record<string, unknown>;
    dataMap: CrmActivityRecord[][];  // array of groups (by date)
    hasMore: boolean;
    dataNorFileMap: Record<string, unknown>;
    serverTime: number;
  };
}

// 从文件或环境变量读取 CRM Cookie
function getCrmCookie(): string | null {
  // 环境变量优先（CI）
  if (process.env.XSY_CRM_COOKIE) return process.env.XSY_CRM_COOKIE;

  try {
    if (fs.existsSync(CRM_COOKIE_FILE)) {
      const data = JSON.parse(fs.readFileSync(CRM_COOKIE_FILE, "utf-8"));
      return data.cookie || null;
    }
  } catch { /* ignore */ }
  return null;
}

// 保存 CRM Cookie 到文件
export function saveCrmCookie(cookie: string): void {
  const dir = CRM_COOKIE_FILE.substring(0, CRM_COOKIE_FILE.lastIndexOf("/"));
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CRM_COOKIE_FILE, JSON.stringify({
    cookie,
    updatedAt: Date.now(),
  }, null, 2));
}

// 清除 CRM Cookie
export function clearCrmCookie(): void {
  try { fs.unlinkSync(CRM_COOKIE_FILE); } catch { /* ignore */ }
}

// 检查 CRM Cookie 是否已配置
export function hasCrmCookie(): boolean {
  return getCrmCookie() !== null;
}

// 获取活动记录（跟进列表）
// objectId: 1=客户, 3=销售机会
// itemId: 关联对象的 ID（必填）
// pageNo: 页码
// pageSize: 每页条数
export async function fetchActivityRecords(
  objectId: number,
  itemId: string,
  pageNo = 1,
  pageSize = 20,
): Promise<ApiResponse<QueryResult>> {
  const cookie = getCrmCookie();
  if (!cookie) {
    throw new Error("CRM Cookie 未配置，请先用浏览器获取 Cookie 后运行: xsy auth crm-cookie");
  }

  const params: Record<string, string> = {
    objectId: String(objectId),
    pageNo: String(pageNo),
    pageSize: String(pageSize),
    as: "1",
    needTotal: "true",
  };
  params.itemId = itemId;
  params.startTime = "";
  params.key = "";

  const response = await axios.get<CrmActivityResponse>(
    `${CRM_BASE_URL}/json/crm_activityrecord/record-search.action`,
    {
      params,
      timeout: DEFAULT_TIMEOUT,
      headers: { Cookie: cookie },
    }
  );

  if (response.data.status !== 0) {
    return {
      code: response.data.status,
      msg: response.data.statusText || "CRM API error",
      result: { totalSize: 0, count: 0, records: [] },
    };
  }

  // 将 dataMap (分组数组) 展平为 records
  const dataMap = response.data.data?.dataMap || [];
  const records: Record<string, unknown>[] = [];
  for (const group of dataMap) {
    for (const item of group) {
      records.push({
        id: String(item.id),
        name: item.name,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        ownerId: String(item.ownerId || ""),
        fromBelongName: item.fromBelongName || "",
        fromName: item.from?.name || "",
      });
    }
  }

  return {
    code: 200,
    msg: "操作成功",
    result: {
      totalSize: records.length,
      count: records.length,
      records,
    },
  };
}
