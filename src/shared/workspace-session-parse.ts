import { workspaceSessionStateSchema } from './workspace-session-schema'
import {
  describeWorkspaceSessionError,
  WORKSPACE_SESSION_UNVALIDATABLE,
  type ParsedWorkspaceSession
} from './workspace-session-parse-error'

export type { ParsedWorkspaceSession } from './workspace-session-parse-error'
export { describeWorkspaceSessionError, WORKSPACE_SESSION_UNVALIDATABLE } from './workspace-session-parse-error'

/** Return null when pathological input makes validation throw during startup. */
export function safeParseWorkspaceSession(
  raw: unknown
): ReturnType<typeof workspaceSessionStateSchema.safeParse> | null {
  try {
    return workspaceSessionStateSchema.safeParse(raw)
  } catch {
    return null
  }
}

/** Validate raw JSON as a WorkspaceSessionState. Returns a discriminated union
 *  so callers can fall back to defaults on failure without a try/catch. */
export function parseWorkspaceSession(raw: unknown): ParsedWorkspaceSession {
  const result = safeParseWorkspaceSession(raw)
  if (!result) {
    return { ok: false, error: WORKSPACE_SESSION_UNVALIDATABLE }
  }
  if (result.success) {
    return { ok: true, value: result.data }
  }
  return { ok: false, error: describeWorkspaceSessionError(result.error) }
}
