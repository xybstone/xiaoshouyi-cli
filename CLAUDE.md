# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

`xiaoshouyi-cli` is a CLI tool for 销售易 CRM, designed as an AI Agent interface. Bin name: `xsy`. Node.js >= 22, TypeScript strict mode, ESM only.

## Commands

```bash
npm run build          # tsup — bundles src/cli.ts → dist/cli.js (esm, node22 target)
npm run dev            # tsup --watch
npm run start          # node dist/cli.js
npm test               # vitest run
npm run test:watch     # vitest (watch mode)
```

## Architecture

### Entry: `src/cli.ts`

Single Commander program that registers all subcommands. Global flags (`--format`, `--jq`, `--fields`, `--verbose`, `--debug`, `--yes`, `--dry-run`, `--timeout`) are defined at the top level and inherited.

### Auth: `src/auth/`

OAuth2 Password Grant flow against `login.xiaoshouyi.com`. `AuthManager` is a global singleton. It auto-refreshes tokens 1 minute before expiry and supports `XSY_ACCESS_TOKEN` env var passthrough for CI.

Storage priority: macOS Keychain → `~/.config/xiaoshouyi-cli/auth.json`. The `AuthStorage` interface has `read()`/`write()`/`delete()`; both `KeychainStorage` and `FileStorage` implement it.

### API clients: `src/api/`

Two HTTP clients for different backend domains:

- **`client.ts`** — Singleton Axios instance for the REST API (`api.xiaoshouyi.com`). Request interceptor injects `Authorization: Bearer` header; response interceptor catches 401 → refreshes token → retries once. Dynamic `baseURL` from auth state (supports tenant-specific API URLs).
- **`crm-client.ts`** — Cookie-based client for `crm.xiaoshouyi.com` Java action endpoints. Used for activity records (follows/visits) because the REST API disables the `activityRecord` object. Cookie stored at `~/.config/xiaoshouyi-cli/crm-cookie.json` or `XSY_CRM_COOKIE` env var. The `fetchActivityRecords()` function flattens the CRM API's grouped `dataMap` response into the standard `QueryResult` shape.

`errors.ts` defines the error hierarchy: `XsyError` → `AuthError`, `ApiError`, `NetworkError`. `classifyError()` converts axios errors into typed errors.

### Service layer: `src/services/object.service.ts`

Generic CRUD functions (`describeObject`, `getObject`, `createObject`, `updateObject`, `deleteObject`, `queryObjects`) — all accept an `apiKey` parameter so they work for any CRM object type. This is the single integration point between commands and the API.

### Commands: `src/commands/`

- **`auth.ts`** — `xsy auth login|status|logout|reset|crm-cookie`
- **`crud.ts`** — Generic commands: `xsy query`, `xsy describe`, `xsy get`, `xsy create`, `xsy update`, `xsy delete`. All wrapped with `withAuth()`.
- **`account.ts`** — Semantic aliases for the `account` object: `list`, `search`, `get`, `create`, `update`, `delete`, `follows`. The `follows` subcommand calls `fetchActivityRecords()` (CRM domain, no auth required).
- **`opportunity.ts`** — Same pattern for `opportunity` + `stages` subcommand + `follows`.
- **`visit.ts`** — `visit list|get|create`. `list` uses CRM domain; `get`/`create` use REST API (`visitRecord` apiKey).
- **`shared.ts`** — Reusable helpers (`fmt`, `parseFields`, `parseData`, `handleError`) shared across semantic command files.
- **`meta.ts`** — `xsy meta ls` (lists apiKey mappings) and `xsy schema` (agent command discovery, JSON output).

### Middleware: `src/middleware/auth-check.ts`

`withAuth(fn)` wraps a Commander action handler — calls `requireAuth()` first, which exits with an error JSON if not authenticated.

### Utilities: `src/utils/index.ts`

`buildListQuery()` and `buildSearchQuery()` construct SQL queries respecting the CRM's SQL dialect (no `*`, `like` only suffix wildcard, `limit offset,size`). `formatTable()` renders CJK-aware aligned markdown tables.

### Output formatting: `src/api/format.ts`

Three modes: `json` (default, Agent-friendly), `table` (human-readable), `raw`. `formatOutput()` extracts `result` from `ApiResponse` and dispatches to the right formatter.

### Skill: `skill/SKILL.md`

Qoder/Claude Code skill definition with intent routing table, safety rules, SQL query constraints, and troubleshooting guide. The `skill/references/` directory contains supplementary docs.

## CRM API constraints

- SQL `select` does not support `*` — list fields explicitly
- `like` only suffix wildcard: `field like 'value%'`
- Pagination via `limit offset,size`, max 100 per page
- `order by` only supports `id` on generic queries; semantic account list additionally allows `accountName`, `createdAt`
- Delete is irreversible and requires `--yes` / `-y` flag

## Testing

Tests live in `tests/unit/` and use vitest. Pure function tests (error classification, output formatting, SQL query building) — no network mocks.
