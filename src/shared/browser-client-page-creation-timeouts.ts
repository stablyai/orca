/**
 * How long the runtime waits for a client host to answer one page-creation command, and the ceiling
 * a caller may raise that to.
 *
 * Shared rather than private to the runtime because the renderer's own waits are only meaningful
 * relative to it: a UI bound shorter than one creation attempt calls healthy recoveries dead.
 */
export const DEFAULT_CLIENT_PAGE_CREATION_TIMEOUT_MS = 30_000
export const MAX_CLIENT_PAGE_CREATION_TIMEOUT_MS = 60_000
