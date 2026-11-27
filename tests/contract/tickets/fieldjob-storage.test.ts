// Synthetic bytes and injected fetch only: this suite never contacts storage or CRM.
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FIELDJOB_STORAGE_ORIGIN, downloadFieldJobStorage, fieldJobAnonymousStorageUrl,
} from "../../../src/tickets/fieldjob-storage.js";
import type { FileBinding } from "../../../src/tickets/types.js";

const content = Buffer.from("Synthetic anonymous storage fixture. No customer data.\n");
const file: Pick<FileBinding, "size" | "sha256"> = {
  size: content.length, sha256: createHash("sha256").update(content).digest("hex"),
};
const href = `${FIELDJOB_STORAGE_ORIGIN}/synthetic/opaque-original.txt`;
const attachment = { fileUrl: href };
let accidentalFetch: ReturnType<typeof vi.fn>;

function response(bytes: Uint8Array = content, options: {
  status?: number; headers?: HeadersInit; url?: string; redirected?: boolean;
} = {}) {
  const value = new Response(bytes, { status: options.status ?? 200, headers: options.headers });
  if (options.url !== undefined) Object.defineProperty(value, "url", { value: options.url });
  if (options.redirected !== undefined) Object.defineProperty(value, "redirected", { value: options.redirected });
  return value;
}

async function downloadFailure(pending: Promise<unknown>, forbidden: string[] = []) {
  let caught: unknown;
  try { await pending; } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(Error);
  expect(caught).toMatchObject({ code: "DOWNLOAD_FAILED" });
  const exposed = `${String(caught)} ${JSON.stringify(caught)}`;
  for (const secret of [href, FIELDJOB_STORAGE_ORIGIN, ...forbidden]) expect(exposed).not.toContain(secret);
}

beforeEach(() => {
  accidentalFetch = vi.fn(() => { throw new Error("Global fetch is forbidden in storage contract tests"); });
  vi.stubGlobal("fetch", accidentalFetch);
});
afterEach(() => {
  try { expect(accidentalFetch).not.toHaveBeenCalled(); }
  finally { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); }
});

describe("verified fieldJob anonymous storage URL", () => {
  it("pins the single observed HTTPS storage origin", () => {
    expect(FIELDJOB_STORAGE_ORIGIN).toBe("https://xsybucket.s3.cn-north-1.amazonaws.com.cn");
  });

  it.each([
    { fileUrl: href }, { fileUrl: href, url: "" }, { fileUrl: href, url: href },
  ])("accepts the exact fileUrl when url is absent, empty or identical: %j", descriptor => {
    expect(fieldJobAnonymousStorageUrl(descriptor)).toBe(href);
  });

  it.each([
    undefined, null, [], href, {}, { url: href }, { fileUrl: 123 },
    { fileUrl: "not an absolute URL" },
    { fileUrl: href.replace("https:", "http:") },
    { fileUrl: "https://other-cdn.example.test/synthetic/object" },
    { fileUrl: `${FIELDJOB_STORAGE_ORIGIN}.outside.example.test/synthetic/object` },
    { fileUrl: "https://outside.example.test/xsybucket.s3.cn-north-1.amazonaws.com.cn/object" },
    { fileUrl: href, url: "https://other-cdn.example.test/download" },
    { fileUrl: href, url: `${FIELDJOB_STORAGE_ORIGIN}/different-object` },
    { fileUrl: href, url: `${href}?download=1` },
  ])("does not identify an unrelated or conflicting descriptor as anonymous storage: %j", descriptor => {
    expect(fieldJobAnonymousStorageUrl(descriptor)).toBeUndefined();
  });

  it.each([
    FIELDJOB_STORAGE_ORIGIN,
    `${FIELDJOB_STORAGE_ORIGIN}/`,
    `${href}?signature=synthetic-secret`,
    `${href}?`,
    `${href}#private-fragment`,
    `${href}#`,
    href.replace("https://", "https://user:synthetic-password@"),
    `${FIELDJOB_STORAGE_ORIGIN}/synthetic/../object`,
    `${FIELDJOB_STORAGE_ORIGIN}/synthetic/./object`,
    `${FIELDJOB_STORAGE_ORIGIN}/synthetic/%2e%2e/object`,
    `${FIELDJOB_STORAGE_ORIGIN}/synthetic/.%2e/object`,
    `${FIELDJOB_STORAGE_ORIGIN}/synthetic/%2e./object`,
    `${FIELDJOB_STORAGE_ORIGIN}/synthetic/object%2fchild`,
    `${FIELDJOB_STORAGE_ORIGIN}/synthetic/object%5cchild`,
    `${FIELDJOB_STORAGE_ORIGIN}/synthetic\\object`,
    `${FIELDJOB_STORAGE_ORIGIN}/synthetic/object%00`,
    `${FIELDJOB_STORAGE_ORIGIN}/synthetic/object%0a`,
    `${FIELDJOB_STORAGE_ORIGIN}/synthetic/object\n`,
  ])("rejects unsafe URLs on the recognized origin: %s", fileUrl => {
    expect(() => fieldJobAnonymousStorageUrl({ fileUrl })).toThrowError(expect.objectContaining({ code: "UNVERIFIED" }));
  });
});

describe("anonymous fieldJob storage download", () => {
  it("streams and verifies the original bytes using an unauthenticated GET", async () => {
    let index = 0;
    const chunks = [content.subarray(0, 9), content.subarray(9, 27), content.subarray(27)];
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index < chunks.length) controller.enqueue(chunks[index++]);
        else controller.close();
      },
    }, { highWaterMark: 0 });
    const result = new Response(body, { headers: { "content-length": String(file.size) } });
    Object.defineProperty(result, "url", { value: href });
    const arrayBuffer = vi.spyOn(result, "arrayBuffer");
    const fetchImpl = vi.fn(async () => result);

    const bytes = await downloadFieldJobStorage(attachment, file, { fetchImpl });

    expect(Buffer.isBuffer(bytes)).toBe(true);
    expect(bytes).toEqual(content);
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(href);
    expect(init).toMatchObject({ method: "GET", credentials: "omit", redirect: "manual" });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.headers).toBeUndefined();
    expect(Object.keys(init).sort()).toEqual(["credentials", "method", "redirect", "signal"]);
  });

  it("allows an absent content-length header and the empty response URL of a synthetic response", async () => {
    const fetchImpl = vi.fn(async () => response());
    await expect(downloadFieldJobStorage(attachment, file, { fetchImpl })).resolves.toEqual(content);
  });

  it.each([
    { fileUrl: "https://other-cdn.example.test/private/object" },
    { fileUrl: href, url: "https://other-cdn.example.test/download" },
    { fileUrl: `${href}?signature=private` },
  ])("does not issue a request for an unverified descriptor: %j", async descriptor => {
    const fetchImpl = vi.fn(async () => response());
    await expect(downloadFieldJobStorage(descriptor, file, { fetchImpl })).rejects.toMatchObject({ code: "UNVERIFIED" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("stops a streamed body immediately after it exceeds the original file size", async () => {
    let reads = 0;
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        reads++;
        if (reads === 1) controller.enqueue(content);
        else if (reads === 2) controller.enqueue(Buffer.from("!"));
        else throw new Error("The oversized stream must not be read further");
      },
      cancel,
    }, { highWaterMark: 0 });
    const fetchImpl = vi.fn(async () => new Response(body));

    await downloadFailure(downloadFieldJobStorage(attachment, file, { fetchImpl }));

    expect(reads).toBe(2);
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("rejects a truncated body even when every received byte is from the original file", async () => {
    const fetchImpl = vi.fn(async () => response(content.subarray(0, -1)));
    await downloadFailure(downloadFieldJobStorage(attachment, file, { fetchImpl }));
  });

  it("rejects a same-length body with a different SHA-256", async () => {
    const changed = Buffer.from(content); changed[0] ^= 1;
    const fetchImpl = vi.fn(async () => response(changed));
    await downloadFailure(downloadFieldJobStorage(attachment, file, { fetchImpl }));
  });

  it.each(["-1", "not-a-length", "1.5", String(file.size - 1), String(file.size + 1), "9007199254740992"])(
    "rejects an invalid or inconsistent content-length of %s", async length => {
      const fetchImpl = vi.fn(async () => response(content, { headers: { "content-length": length } }));
      await downloadFailure(downloadFieldJobStorage(attachment, file, { fetchImpl }));
      expect(fetchImpl).toHaveBeenCalledOnce();
    },
  );

  it.each([201, 206, 301, 302, 307, 403, 500])("rejects HTTP %s without retrying", async status => {
    const fetchImpl = vi.fn(async () => response(content, {
      status, headers: { location: "https://outside.example.test/private-redirect?secret=synthetic" },
    }));
    await downloadFailure(downloadFieldJobStorage(attachment, file, { fetchImpl }), ["private-redirect", "synthetic"]);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it.each([
    { url: `${FIELDJOB_STORAGE_ORIGIN}/different-private-object` },
    { url: "https://outside.example.test/private-redirect" },
    { url: `${href}?unexpected=private` },
    { redirected: true, url: href },
  ])("rejects a changed resource or a followed redirect: %j", async options => {
    const fetchImpl = vi.fn(async () => response(content, options));
    await downloadFailure(downloadFieldJobStorage(attachment, file, { fetchImpl }), ["different-private-object", "private-redirect"]);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("rejects a bodyless success response", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    await downloadFailure(downloadFieldJobStorage(attachment, file, { fetchImpl }));
  });

  it.each(["fetch", "stream"])("does not expose URLs or raw %s error text", async stage => {
    const detail = `private-transport-detail ${href}?credential=synthetic-secret`;
    const fetchImpl = vi.fn(async () => {
      if (stage === "fetch") throw new Error(detail);
      return new Response(new ReadableStream({ start(controller) { controller.error(new Error(detail)); } }));
    });
    await downloadFailure(downloadFieldJobStorage(attachment, file, { fetchImpl }), [detail, "private-transport-detail", "synthetic-secret"]);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it.each([
    { ...file, size: 0 }, { ...file, size: -1 }, { ...file, size: 1.5 },
    { ...file, size: 20 * 1024 * 1024 + 1 },
    { ...file, sha256: "" }, { ...file, sha256: "not-a-hash" },
  ])("requires a valid original file binding within the 20 MiB cap: %j", async original => {
    const fetchImpl = vi.fn(async () => response());
    await expect(downloadFieldJobStorage(attachment, original, { fetchImpl })).rejects.toMatchObject({ code: "INVALID_PLAN" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("anonymous storage deadlines", () => {
  it("bounds the whole fetch with the default 30000 ms timeout even if fetch ignores abort", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const fetchImpl = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return new Promise<Response>(() => undefined);
    });
    const pending = downloadFieldJobStorage(attachment, file, { fetchImpl });
    const failure = downloadFailure(pending);
    let settled = false;
    void pending.then(() => { settled = true; }, () => { settled = true; });

    await vi.advanceTimersByTimeAsync(29999);
    expect(settled).toBe(false);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await failure;
    expect(signal?.aborted).toBe(true);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds body streaming and does not wait for a stalled cancellation", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const body = new ReadableStream<Uint8Array>({
      pull: () => new Promise<void>(() => undefined), cancel,
    }, { highWaterMark: 0 });
    const fetchImpl = vi.fn(async () => new Response(body));
    const failure = downloadFailure(downloadFieldJobStorage(attachment, file, { fetchImpl, timeoutMs: 25 }));

    await vi.advanceTimersByTimeAsync(25);
    await failure;

    expect(cancel).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([1, 60000])("accepts a bounded timeout of %s ms and clears its timer on success", async timeoutMs => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(async () => response());
    await expect(downloadFieldJobStorage(attachment, file, { fetchImpl, timeoutMs })).resolves.toEqual(content);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([0, -1, 1.5, 60001, NaN, Infinity])("rejects an invalid timeout of %s before any request", async timeoutMs => {
    const fetchImpl = vi.fn(async () => response());
    await expect(downloadFieldJobStorage(attachment, file, { fetchImpl, timeoutMs })).rejects.toMatchObject({ code: "INVALID_CONFIG" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
