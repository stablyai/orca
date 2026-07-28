/**
 * Native agent-reported working directory: the tri-state signal an agent CLI
 * hook payload carries about where the agent itself is running, which can differ
 * from the pane's spawn worktree (e.g. `claude -w <name>`).
 *
 * `string` = accepted replacement, `null` = present but invalid (clear the
 * cached location), `undefined` = absent (preserve whatever is cached).
 */
export type AgentReportedCwdUpdate = string | null | undefined

export const AGENT_REPORTED_CWD_MAX_LENGTH = 4096

// Why: first alias that is *present* decides; a present-but-invalid preferred
// alias must not silently fall through to a lower-precedence one.
const REPORTED_CWD_ALIASES = ['cwd', 'workspaceRoot', 'workspace_root'] as const

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) {
      return true
    }
  }
  return false
}

function isCompleteUncPath(value: string): boolean {
  const parts = value.replace(/\\/g, '/').slice(2).split('/')
  return Boolean(parts[0] && parts[1])
}

/** Returns the trimmed path when it is an acceptable absolute location, else null. */
export function validateAgentReportedCwd(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > AGENT_REPORTED_CWD_MAX_LENGTH) {
    return null
  }
  if (hasControlCharacter(trimmed)) {
    return null
  }
  if (trimmed.startsWith('//') || trimmed.startsWith('\\\\')) {
    return isCompleteUncPath(trimmed) ? trimmed : null
  }
  if (trimmed.startsWith('/')) {
    return trimmed
  }
  // Why: `C:dir` is drive-relative and `\dir` is relative to the current drive;
  // neither names a location on its own, so only drive-rooted forms pass.
  return /^[A-Za-z]:[\\/]/.test(trimmed) ? trimmed : null
}

/** Reads the tri-state update out of a raw provider hook payload. */
export function extractAgentReportedCwdUpdate(payload: unknown): AgentReportedCwdUpdate {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return undefined
  }
  const record = payload as Record<string, unknown>
  for (const alias of REPORTED_CWD_ALIASES) {
    if (!(alias in record) || record[alias] === undefined) {
      continue
    }
    return validateAgentReportedCwd(record[alias])
  }
  return undefined
}

/** Applies a tri-state update to the merged location held on a status record. */
export function mergeAgentReportedCwd(
  previous: string | undefined,
  update: AgentReportedCwdUpdate
): string | undefined {
  if (update === undefined) {
    return previous
  }
  return validateAgentReportedCwd(update) ?? undefined
}

/**
 * Applies an accepted status event's cwd update under the accepted-root rules
 * shared by main and the renderer. Callers must not invoke it for events their
 * identity/stale guards already rejected — those leave the location untouched.
 */
export function resolveAcceptedRootReportedCwd(args: {
  previous: string | undefined
  update: AgentReportedCwdUpdate
  /** True when `resolveAgentStatusIdentity` attributed the event to nested child traffic under a live root. */
  inheritedFromActivePane: boolean
  /** True when a different root agent took over the pane from a root that is no longer active. */
  rootAgentChanged: boolean
}): string | undefined {
  if (args.inheritedFromActivePane) {
    return args.previous
  }
  return mergeAgentReportedCwd(args.rootAgentChanged ? undefined : args.previous, args.update)
}

/** Re-validates a transport-carried value back into the tri-state domain. */
export function normalizeAgentReportedCwdUpdate(value: unknown): AgentReportedCwdUpdate {
  return value === undefined ? undefined : validateAgentReportedCwd(value)
}
