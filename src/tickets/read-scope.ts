import type { TicketBackend } from "./types.js";

// Each public operation gets its own metadata reads. In particular, execute
// starts a new scope rather than reusing the metadata read during prepare.
export function withFreshReads<T>(backend: TicketBackend, operation: () => Promise<T>): Promise<T> {
  return backend.withReadScope ? backend.withReadScope(operation) : operation();
}
