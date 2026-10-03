// The identities of the rows a host writes about a stop, shared with the readers that must not say
// the same stop twice (`native-chat-cut-turn-notice`).
//
// Contract: a new row that explains a stop must carry the providerExited fact or one of these
// prefixes, or a client derives a second notice beside it.

/** The exit row the unexpected-exit settle writes, keyed by the child that exited. */
export const PROVIDER_EXIT_ROW_PREFIX = 'provider-exit:'
/** The exit row a reopen or acquire writes for a generation found dead. */
export const STALE_SESSION_ROW_PREFIX = 'stale-session:'
/** The note the restart continuation leaves about its outcome. */
export const RESTART_CONTINUATION_ROW_PREFIX = 'restart-continuation:'
