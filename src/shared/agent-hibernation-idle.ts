// Why this lives in shared/ rather than beside the planner: the planner module
// pulls renderer-only imports, but the idle-timeout clamp itself is plain
// arithmetic that both processes need. The settings pane clamps user input with
// it, and the main-process auto-resume service reuses the same value as the
// wait-for-reset menu grace — a second copy would let the two drift, so a widened
// range in settings would silently keep enforcing the old bounds on the grace.

export const DEFAULT_AGENT_HIBERNATION_IDLE_MS = 30 * 60 * 1000
export const MIN_AGENT_HIBERNATION_IDLE_MS = 60 * 1000
export const MAX_AGENT_HIBERNATION_IDLE_MS = 24 * 60 * 60 * 1000

/** Clamp a persisted/user-supplied idle timeout, falling back to the default for
 *  anything out of range or not a finite number. */
export function getEffectiveAgentHibernationIdleMs(value: unknown): number {
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= MIN_AGENT_HIBERNATION_IDLE_MS &&
    value <= MAX_AGENT_HIBERNATION_IDLE_MS
    ? value
    : DEFAULT_AGENT_HIBERNATION_IDLE_MS
}
