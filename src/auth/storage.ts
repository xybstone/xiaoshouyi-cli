// 凭据存储抽象 — macOS Keychain（优先） + 文件（兜底）

import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import path from "node:path";
import type { AuthState } from "../types/index.js";
import { CONFIG_DIR, AUTH_FILE } from "../config.js";

// ---- 抽象接口 ----

export interface AuthStorage {
  read(): AuthState | null;
  write(state: AuthState): void;
  delete(): void;
}

// ---- macOS Keychain 实现 ----

const KEYCHAIN_SERVICE = "xiaoshouyi-cli";
const KEYCHAIN_ACCOUNT = "auth";

let _keychainAvailable: boolean | null = null;

function keychainAvailable(): boolean {
  if (_keychainAvailable !== null) return _keychainAvailable;
  try {
    execSync("security -v", { stdio: "ignore" });
    _keychainAvailable = process.platform === "darwin";
  } catch {
    _keychainAvailable = false;
  }
  return _keychainAvailable;
}

export class KeychainStorage implements AuthStorage {
  read(): AuthState | null {
    if (!keychainAvailable()) return null;
    try {
      const raw = execSync(
        `security find-generic-password -s "${KEYCHAIN_SERVICE}" -a "${KEYCHAIN_ACCOUNT}" -w`,
        { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }
      ).trim();
      if (!raw) return null;
      return JSON.parse(raw) as AuthState;
    } catch {
      return null;
    }
  }

  write(state: AuthState): void {
    if (!keychainAvailable()) return;
    const json = JSON.stringify(state);
    // -U (upsert) handles create-or-update, no need for manual delete
    execSync(
      `security add-generic-password -s "${KEYCHAIN_SERVICE}" -a "${KEYCHAIN_ACCOUNT}" -w - -U`,
      { input: json, stdio: ["pipe", "ignore", "ignore"] }
    );
  }

  delete(): void {
    if (!keychainAvailable()) return;
    try {
      execSync(
        `security delete-generic-password -s "${KEYCHAIN_SERVICE}" -a "${KEYCHAIN_ACCOUNT}"`,
        { stdio: "ignore" }
      );
    } catch { /* ignore */ }
  }
}

// ---- 文件存储实现（兜底 / CI 环境） ----

export class FileStorage implements AuthStorage {
  read(): AuthState | null {
    try {
      if (!existsSync(AUTH_FILE)) return null;
      const raw = readFileSync(AUTH_FILE, "utf-8");
      return JSON.parse(raw) as AuthState;
    } catch {
      return null;
    }
  }

  write(state: AuthState): void {
    mkdirSync(path.dirname(AUTH_FILE), { recursive: true });
    writeFileSync(AUTH_FILE, JSON.stringify(state, null, 2), {
      mode: 0o600,
      encoding: "utf-8",
    });
  }

  delete(): void {
    try {
      if (existsSync(AUTH_FILE)) unlinkSync(AUTH_FILE);
    } catch { /* ignore */ }
  }
}

// ---- 工厂：优先 Keychain，兜底 File ----

export function createAuthStorage(): AuthStorage {
  if (keychainAvailable()) {
    return new KeychainStorage();
  }
  return new FileStorage();
}
