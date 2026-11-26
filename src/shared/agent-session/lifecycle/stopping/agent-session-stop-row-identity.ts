// New stop-explanation rows need providerExited or these prefixes; otherwise native-chat-cut-turn-notice derives a duplicate notice.

/** The exit row the child-exit settle writes for an unexpected exit, keyed by the child that exited. */
export const PROVIDER_EXIT_ROW_PREFIX = 'provider-exit:'
/** The exit row a reopen or acquire writes for a generation found dead. */
export const STALE_SESSION_ROW_PREFIX = 'stale-session:'
/** The note the restart continuation leaves about its outcome. */
export const RESTART_CONTINUATION_ROW_PREFIX = 'restart-continuation:'
