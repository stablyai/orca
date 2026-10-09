import type { z } from 'zod'
import type { WorkspaceSessionState } from './workspace-session-state-types'

export type ParsedWorkspaceSession =
  | { ok: true; value: WorkspaceSessionState }
  | { ok: false; error: string }

/** Why: keep the error compact — a zod issue dump is noisy and most of the time
 *  only the first divergent field is actionable for debugging. */
export function describeWorkspaceSessionError(error: z.ZodError): string {
  const firstIssue = error.issues[0]
  const path = firstIssue?.path.join('.') || '<root>'
  return `${path}: ${firstIssue?.message ?? 'invalid session'}`
}

export const WORKSPACE_SESSION_UNVALIDATABLE = '<root>: session could not be validated'
