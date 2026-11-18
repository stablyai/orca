import type { WorkspaceSessionPatch, WorkspaceSessionState } from './workspace-session-state-types'
import { isWorkspaceSessionRecord } from './workspace-session-host-records'

type SessionField = keyof WorkspaceSessionState

/** The keys of one record field a window changed since main last acknowledged that field. */
export type WorkspaceSessionFieldEntryChanges = {
  set: Record<string, unknown>
  remove: string[]
}

/** A window save that carries whole values only for fields that aren't keyed records (or that main
 *  hasn't acknowledged yet), and only the changed keys of the rest: one tab switch in a large fleet
 *  then sends one workspace's entries instead of every workspace's. */
export type WorkspaceSessionEntriesPatch = {
  fields: WorkspaceSessionPatch
  entries: Partial<Record<SessionField, WorkspaceSessionFieldEntryChanges>>
}

export type WorkspaceSessionEntriesPatchResult = 'applied' | 'unchanged' | 'skipped'

function isFieldEntryChanges(value: unknown): value is WorkspaceSessionFieldEntryChanges {
  return (
    isWorkspaceSessionRecord(value) &&
    isWorkspaceSessionRecord(value.set) &&
    Array.isArray(value.remove) &&
    value.remove.every((key) => typeof key === 'string')
  )
}

/** Whole fields for the existing patch path: each changed record is the stored one with the window's
 *  keys set and removed, so entries it didn't touch keep their stored values and identities. */
export function applyWorkspaceSessionEntriesPatch(
  stored: WorkspaceSessionState,
  patch: WorkspaceSessionEntriesPatch
): WorkspaceSessionPatch {
  const whole: WorkspaceSessionPatch = isWorkspaceSessionRecord(patch?.fields)
    ? { ...patch.fields }
    : {}
  const entries = isWorkspaceSessionRecord(patch?.entries) ? patch.entries : {}
  for (const [field, changes] of Object.entries(entries) as [SessionField, unknown][]) {
    if (!isFieldEntryChanges(changes)) {
      continue
    }
    const current = stored[field]
    const next: Record<string, unknown> = isWorkspaceSessionRecord(current) ? { ...current } : {}
    for (const key of changes.remove) {
      delete next[key]
    }
    Object.assign(next, changes.set)
    ;(whole as Record<string, unknown>)[field] = next
  }
  return whole
}
