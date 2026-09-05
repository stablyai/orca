/** How long an in-flight/just-finished process-table capture may be reused before a fresh `ps`.
 *
 *  Deliberately a leaf module with no imports: the renderer schedules pane inspections against
 *  this bound, and reaching it through the reader drags `node:child_process`/`node:fs` and a
 *  top-level `process.platform` into the renderer bundle, which throws before React mounts. */
export const DEFAULT_PROCESS_TABLE_SNAPSHOT_TTL_MS = 500

/** How much older than its own await a TTL-cached capture may be, on top of the capture's own
 *  duration. Reported ages carry both, so this alone is not the staleness bound. */
export const PROCESS_TABLE_SNAPSHOT_MAX_STALENESS_MS = DEFAULT_PROCESS_TABLE_SNAPSHOT_TTL_MS
