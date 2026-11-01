/**
 * How long a paired socket may take from open to authenticated, on both ends. The desktop closes a
 * socket that has not authenticated by then, so a phone that gives up sooner drops slow links the
 * desktop would still have accepted.
 */
export const PAIRED_E2EE_HANDSHAKE_DEADLINE_MS = 10_000
