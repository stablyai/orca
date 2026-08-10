import type { WorkspaceSessionState } from './types'
import {
  describeWorkspaceSessionError,
  safeParseWorkspaceSession,
  WORKSPACE_SESSION_UNVALIDATABLE
} from './workspace-session-schema'
import { collectSalvageDrops } from './zod-salvage'

export type SalvagedWorkspaceSession =
  | { ok: true; value: WorkspaceSessionState; droppedPaths: string[]; droppedCount: number }
  | { ok: false; error: string }

/** Remove undefined keys that would shadow caller defaults during object spread. */
function withoutSalvagedAwayFields(session: WorkspaceSessionState): WorkspaceSessionState {
  return Object.fromEntries(
    Object.entries(session).filter(([, value]) => value !== undefined)
  ) as WorkspaceSessionState
}

/** Validate a session, preserving valid entries and reporting bounded repair diagnostics. */
export function parseWorkspaceSessionSalvaging(raw: unknown): SalvagedWorkspaceSession {
  const {
    value: result,
    droppedPaths,
    droppedCount
  } = collectSalvageDrops(() => safeParseWorkspaceSession(raw))
  if (!result) {
    return { ok: false, error: WORKSPACE_SESSION_UNVALIDATABLE }
  }
  if (!result.success) {
    return { ok: false, error: describeWorkspaceSessionError(result.error) }
  }
  return { ok: true, value: withoutSalvagedAwayFields(result.data), droppedPaths, droppedCount }
}
