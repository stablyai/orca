/** Per-plugin bridge budgets, enforced host-side. */
export const PANEL_MESSAGE_MAX_BYTES = 64 * 1024
export const PANEL_MESSAGE_RATE_LIMIT = { maxMessages: 30, perMs: 10_000 }

/** Size cap for the reserved liveness lane. Deliberately size-only: any
 *  per-window count on this lane can be spent by the panel's own pongs and
 *  would drop the next genuine reply, which is the starvation this reserved
 *  lane exists to prevent. Aggregate cost stays bounded because pongs are also
 *  charged to the data budget and cost O(1) plus a walk capped here. */
export const PANEL_CONTROL_MESSAGE_MAX_BYTES = 1024
