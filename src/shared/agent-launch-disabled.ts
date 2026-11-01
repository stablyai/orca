/**
 * A launch refused because its agent is disabled in Settings → Agents. The refusal happens
 * before any spawn, so it counts as a definite failure with no effects: callers report it
 * as-is instead of the unknown-outcome wrapper (#37045).
 */
export const AGENT_LAUNCH_DISABLED_CODE = 'agent_disabled' as const
