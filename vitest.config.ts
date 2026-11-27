import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Developer shell credentials must never select a real account in tests.
    // Individual fixtures explicitly install synthetic identities/transports.
    env: {
      XSY_NEOCRM_PROJECT: "",
      XSY_ACCESS_TOKEN: "synthetic-test-token-not-valid",
      XSY_API_BASE_URL: "https://127.0.0.1:1",
      XSY_CRM_COOKIE: "",
      XSY_TICKET_CONTRACTS: "",
      XSY_TICKET_WRITES: "",
      XSY_TICKET_APPROVAL_SECRET: "",
      XSY_TICKET_STATE_DIR: "",
    },
  },
});
