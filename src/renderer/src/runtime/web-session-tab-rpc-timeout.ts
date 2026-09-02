/**
 * The budget for a `session.tabs.*` RPC. Client-side suppression that has to outlive one of these
 * calls (the close intent) derives its own lifetime from this, so the two cannot drift apart.
 */
export const WEB_SESSION_TAB_RPC_TIMEOUT_MS = 15_000
