import { createHash } from "node:crypto";
import { fail, object, TicketError, type FileBinding } from "./types.js";

// Observed upload receipt + unauthenticated GET verified against the original
// file's size/SHA-256. This is a single origin, not a general CDN allowlist.
export const FIELDJOB_STORAGE_ORIGIN = "https://xsybucket.s3.cn-north-1.amazonaws.com.cn";

export function fieldJobAnonymousStorageUrl(value: unknown): string | undefined {
  const descriptor = object(value), raw = descriptor.fileUrl;
  if (typeof raw !== "string" || !raw) return undefined;
  let url: URL;
  try { url = new URL(raw); } catch { return undefined; }
  if (url.origin !== FIELDJOB_STORAGE_ORIGIN) return undefined;
  if (descriptor.url !== undefined && descriptor.url !== null && descriptor.url !== "" && descriptor.url !== raw)
    return undefined;
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname === "/" ||
    /[\u0000-\u0020\u007f\\?#]/.test(raw) ||
    /(?:^|\/)(?:\.|%2e){1,2}(?:\/|$)|%2f|%5c|%(?:0[0-9a-f]|1[0-9a-f]|20|7f)/i.test(raw))
    fail("UNVERIFIED", "存储下载地址不符合已核验的匿名读取协议");
  return url.href;
}

/** No CRM client, bearer, cookie, redirect, URL synthesis, or automatic retry. */
export async function downloadFieldJobStorage(
  attachment: unknown,
  file: Pick<FileBinding, "size" | "sha256">,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<Buffer> {
  const href = fieldJobAnonymousStorageUrl(attachment);
  if (!href) fail("UNVERIFIED", "该附件没有已核验的匿名存储下载协议");
  if (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > 20 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(file.sha256))
    fail("INVALID_PLAN", "匿名下载必须绑定原始文件大小和SHA-256");
  const timeoutMs = options.timeoutMs ?? 30000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000)
    fail("INVALID_CONFIG", "匿名存储下载超时必须为1至60000毫秒");
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error("deadline")); }, timeoutMs);
  });
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await Promise.race([(options.fetchImpl ?? globalThis.fetch)(href, {
      method: "GET", credentials: "omit", redirect: "manual", signal: controller.signal,
    }), deadline]);
    if (response.status !== 200 || response.redirected || (response.url && response.url !== href))
      fail("DOWNLOAD_FAILED", "匿名存储下载未返回原始资源，未保存文件");
    const length = response.headers.get("content-length");
    if (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) !== file.size))
      fail("DOWNLOAD_FAILED", "匿名存储响应大小与原始文件不一致，未保存文件");
    if (!response.body) fail("DOWNLOAD_FAILED", "匿名存储下载没有响应内容");
    reader = response.body.getReader();
    const hash = createHash("sha256"), chunks: Buffer[] = [];
    let size = 0;
    for (;;) {
      const next = await Promise.race([reader.read(), deadline]);
      if (next.done) break;
      size += next.value.byteLength;
      if (size > file.size) fail("DOWNLOAD_FAILED", "匿名存储内容超过原始文件大小，未保存文件");
      const chunk = Buffer.from(next.value); hash.update(chunk); chunks.push(chunk);
    }
    if (size !== file.size || hash.digest("hex") !== file.sha256)
      fail("DOWNLOAD_FAILED", "匿名存储内容的大小或SHA-256与原始文件不一致，未保存文件");
    return Buffer.concat(chunks, size);
  } catch (error) {
    if (error instanceof TicketError) throw error;
    return fail("DOWNLOAD_FAILED", "匿名存储下载失败或超时，未保存文件");
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    controller.abort();
    // Cancellation must not extend a failed or timed-out operation indefinitely.
    if (reader) void reader.cancel().catch(() => undefined);
  }
}
