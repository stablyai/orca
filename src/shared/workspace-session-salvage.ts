import type { WorkspaceSessionState } from './types'
import {
  describeWorkspaceSessionError,
  safeParseWorkspaceSession,
  WORKSPACE_SESSION_UNVALIDATABLE
} from './workspace-session-schema'
import { collectSalvageDrops } from './zod-salvage'

export type SalvagedWorkspaceSession =
  | { ok: true; value: WorkspaceSessionState; droppedPaths: string[] }
  | { ok: false; error: string }

/** Why: zod materializes the key of a field that salvaged to absent, and an
 *  explicit undefined would shadow the caller's value in the
 *  `{ ...defaults, ...value }` spread both call sites do. */
function withoutSalvagedAwayFields(session: WorkspaceSessionState): WorkspaceSessionState {
  return Object.fromEntries(
    Object.entries(session).filter(([, value]) => value !== undefined)
  ) as WorkspaceSessionState
}

/** Validate a persisted workspace session, keeping whatever the schema could
 *  salvage. Corrupt entries are dropped per the tolerance each field declares
 *  (see ./zod-salvage) rather than costing the whole session; `droppedPaths`
 *  names each one so the caller can log it, count it, and rewrite the file.
 *  Only a payload that is not a session at all is reported unsalvageable. */
export function parseWorkspaceSessionSalvaging(raw: unknown): SalvagedWorkspaceSession {
  const { value: result, droppedPaths } = collectSalvageDrops(() => safeParseWorkspaceSession(raw))
  if (!result) {
    return { ok: false, error: WORKSPACE_SESSION_UNVALIDATABLE }
  }
  if (!result.success) {
    return { ok: false, error: describeWorkspaceSessionError(result.error) }
  }
  return { ok: true, value: withoutSalvagedAwayFields(result.data), droppedPaths }
}
