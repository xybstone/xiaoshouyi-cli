// CRM 域客户端 — 调用 crm.xiaoshouyi.com 的 Java action 接口
// 用于获取跟进记录、审批等 REST API 禁用的操作

import fs from "node:fs";
import path from "node:path";
import axios from "axios";
import { CRM_BASE_URL, CRM_COOKIE_FILE, DEFAULT_TIMEOUT } from "../config.js";
import { getAuthManager } from "../auth/manager.js";
import type { ApiResponse, QueryResult } from "../types/index.js";

// ---- 常量 ----

// CRM 对象类型常量
export const CRM_OBJECT_ACCOUNT = 1;       // 客户
export const CRM_OBJECT_OPPORTUNITY = 3;   // 销售机会

// 长期有效的 Cookie 前缀（无需频繁刷新）
const PASSPORT_COOKIE_PREFIXES = [
  "x-ienterprise-",
  "v2304LoginState",
  "ssoType",
  "isqywxlogin",
  "c-full-server-name",
  "resDomain",
  "c-user",
  "3222329668260181isNeoWeb",
];

// 需要定期刷新的会话 Cookie 前缀
const SESSION_COOKIE_PREFIXES = [
  "SESSION",
  "JSESSIONID",
  "AUC_SESSION",
];

// ---- Types ----

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

interface CrmActivityResponse {
  status: number;
  statusText: string;
  data: {
    userList: unknown[];
    commentCountMap: Record<string, number>;
    dataImgMap: Record<string, unknown>;
    dataMap: CrmActivityRecord[][];
    hasMore: boolean;
    dataNorFileMap: Record<string, unknown>;
    serverTime: number;
  };
}

// ---- Cookie 管理 ----

/**
 * 从文件或环境变量读取完整 CRM Cookie
 */
export function getCrmCookie(): string | null {
  if (process.env.XSY_CRM_COOKIE) return process.env.XSY_CRM_COOKIE;
  try {
    if (fs.existsSync(CRM_COOKIE_FILE)) {
      const data = JSON.parse(fs.readFileSync(CRM_COOKIE_FILE, "utf-8"));
      return data.cookie || null;
    }
  } catch { /* ignore */ }
  return null;
}

/**
 * 保存 CRM Cookie 到文件，保留长期有效的 passport cookie
 */
export function saveCrmCookie(newCookie: string): void {
  const dir = path.dirname(CRM_COOKIE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  // 合并已有 cookie 中的长期有效项（passport 等）到新 cookie
  const merged = mergeCookies(getCrmCookie(), newCookie);

  fs.writeFileSync(CRM_COOKIE_FILE, JSON.stringify({
    cookie: merged,
    updatedAt: Date.now(),
  }, null, 2));
}

/**
 * 合并新旧 cookie：保留旧 cookie 中的 passport 类键，用新 cookie 中的会话键覆盖
 */
function mergeCookies(oldCookie: string | null, newCookie: string): string {
  const oldParts = oldCookie ? parseCookies(oldCookie) : {};
  const newParts = parseCookies(newCookie);

  // 新 cookie 中已有的键用新的
  // 旧 cookie 中的 passport 类键保留（如果新 cookie 没有提供）
  for (const [key, value] of Object.entries(oldParts)) {
    if (PASSPORT_COOKIE_PREFIXES.some(p => key.startsWith(p)) && !(key in newParts)) {
      newParts[key] = value;
    }
  }

  return Object.entries(newParts)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

function parseCookies(cookieStr: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const part of cookieStr.split(";")) {
    const trimmed = part.trim();
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx > 0) {
      result[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1);
    }
  }
  return result;
}

/**
 * 检查存储的 CRM Cookie 是否包含必要的认证 cookie
 */
export function hasCrmCookie(): boolean {
  return getCrmCookie() !== null;
}

/**
 * 清除 CRM Cookie 文件
 */
export function clearCrmCookie(): void {
  try { fs.unlinkSync(CRM_COOKIE_FILE); } catch { /* ignore */ }
}

/**
 * 从 HTML Response 提取 Set-Cookie 中的 name=value 部分
 */
function extractSetCookie(headers: Record<string, unknown>): string | null {
  const raw = headers["set-cookie"];
  if (!raw) return null;
  const cookies = Array.isArray(raw) ? raw : [raw];
  const parts: string[] = [];
  for (const c of cookies) {
    const seg = String(c).split(";")[0];
    if (seg) parts.push(seg);
  }
  return parts.length > 0 ? parts.join("; ") : null;
}

// ---- CRM 自动登录 -------

/**
 * 使用存储的凭据尝试自动登录 CRM 域。
 *
 * 销售易 CRM 使用 OAuth2 SPA 登录，完全自动化较复杂。
 * 此函数尝试多种方式获取会话，但不保证成功。
 * 推荐方式：在浏览器登录后，用 `xsy auth crm-cookie --auto` 或手动设置 cookie。
 *
 * @returns 成功后的完整 cookie 字符串
 */
export async function loginCrm(): Promise<string> {
  const manager = getAuthManager();
  const username = manager.getUsername();
  const rawPassword = manager.getRawPassword();
  const token = await manager.getToken();
  const existingCookie = getCrmCookie();
  const existingParts = existingCookie ? parseCookies(existingCookie) : {};

  // 尝试方式：用 token 尝试 neologin 端点
  // 销售易 CRM 验证 access_token 来创建会话
  if (token) {
    try {
      const resp = await axios.get<string>(
        `${CRM_BASE_URL}/neologin/skip/v2/auc/oauth2/token/info`,
        {
          params: { access_token: token },
          timeout: DEFAULT_TIMEOUT,
          maxRedirects: 0,
          validateStatus: (status) => true,
          headers: { Cookie: existingCookie || "" },
        }
      );

      const setCookies = resp.headers["set-cookie"];
      if (setCookies) {
        const newSession = Array.isArray(setCookies) ? setCookies : [setCookies];
        const sessionParts = newSession
          .map((c: string) => String(c).split(";")[0])
          .filter(Boolean);
        if (sessionParts.length > 0) {
          const newCookie = sessionParts.join("; ");
          saveCrmCookie(newCookie);
          return newCookie;
        }
      }
    } catch { /* 继续 */ }
  }

  // 如果有已有 cookie，尝试通过访问首页获取新 session
  if (existingCookie) {
    try {
      const resp = await axios.get(CRM_BASE_URL + "/", {
        headers: { Cookie: existingCookie },
        timeout: DEFAULT_TIMEOUT,
        maxRedirects: 0,
        validateStatus: () => true,
      });
      const setCookies = resp.headers["set-cookie"];
      if (setCookies) {
        const newSession = Array.isArray(setCookies) ? setCookies : [setCookies];
        const sessionParts = newSession
          .map((c: string) => String(c).split(";")[0])
          .filter(Boolean);
        if (sessionParts.length > 0) {
          const newCookie = sessionParts.join("; ");
          saveCrmCookie(newCookie);
          return getCrmCookie() || newCookie;
        }
      }
    } catch { /* 继续 */ }
  }

  // 最后的提示
  const hasPassport = existingParts && Object.keys(existingParts).some(k =>
    PASSPORT_COOKIE_PREFIXES.some(p => k.startsWith(p))
  );

  if (hasPassport) {
    throw new Error(
      "CRM 会话已过期，请重新在浏览器登录销售易后，运行: xsy auth crm-cookie --cookie 'JSESSIONID=...; SESSION=...'"
    );
  }

  throw new Error(
    "未找到 CRM Cookie。请在浏览器登录销售易 CRM，打开 F12 → Network，复制任意请求的 Cookie 头后运行:\n" +
    "  xsy auth crm-cookie --cookie '粘贴完整 Cookie 字符串'"
  );
}

// ---- 通用 CRM 域请求 -------

interface CrmRequestOptions {
  /** Cookie 字符串，不传则自动获取 */
  cookie?: string;
  /** 是否启用 Cookie 过期自动刷新重试（默认 true） */
  autoRefresh?: boolean;
}

/**
 * 发起 CRM 域 POST 请求（Java action），支持 Cookie 自动刷新
 */
export async function crmPost<T>(
  actionPath: string,
  params: Record<string, string>,
  options: CrmRequestOptions = {},
): Promise<{ status: number; statusText: string; data: T }> {
  const autoRefresh = options.autoRefresh ?? true;
  let cookie = options.cookie || getCrmCookie();

  if (!cookie) {
    throw new Error(
      "CRM Cookie 未配置。请先运行: xsy auth crm-cookie --auto\n" +
      "或手动设置: xsy auth crm-cookie --cookie '完整 Cookie 字符串'"
    );
  }

  const doRequest = async (c: string) => {
    const response = await axios.post<T>(
      `${CRM_BASE_URL}${actionPath}`,
      new URLSearchParams(params).toString(),
      {
        timeout: DEFAULT_TIMEOUT,
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: c,
        },
        validateStatus: () => true,
      }
    );

    const data = response.data as Record<string, unknown>;

    // 检测是否被重定向到登录页（返回 HTML）
    if (typeof data !== "object" || data === null || !("status" in data)) {
      return { status: -1, statusText: "Session expired or login required", data: null as unknown as T, expired: true };
    }

    return { status: data.status as number, statusText: (data.statusText || "") as string, data: data as T, expired: false };
  };

  let result = await doRequest(cookie);

  if (result.expired && autoRefresh) {
    try {
      const newCookie = await loginCrm();
      result = await doRequest(newCookie);
    } catch {
      // loginCrm 已抛出带提示的错误
      throw new Error("CRM Cookie 已过期，请重新获取: xsy auth crm-cookie --cookie '...'");
    }
  }

  return { status: result.status, statusText: result.statusText, data: result.data };
}

// ---- 活动记录（跟进） -------

/**
 * 获取活动记录（跟进列表），支持 Cookie 过期自动刷新重试
 */
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
    itemId,
    startTime: "",
    key: "",
  };

  const response = await axios.get<CrmActivityResponse>(
    `${CRM_BASE_URL}/json/crm_activityrecord/record-search.action`,
    {
      params,
      timeout: DEFAULT_TIMEOUT,
      headers: { Cookie: cookie },
      validateStatus: () => true,
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
    ext: [{ hasMore: response.data.data?.hasMore ?? false }],
  };
}
