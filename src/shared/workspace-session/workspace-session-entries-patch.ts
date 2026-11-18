import type { WorkspaceSessionPatch, WorkspaceSessionState } from './workspace-session-state-types'
import { isWorkspaceSessionRecord } from './workspace-session-host-records'
import { structuralValuesEqual } from '../collections/structural-value-equality'

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

export type WorkspaceSessionEntriesPatchResult = {
  status: 'applied' | 'unchanged' | 'skipped'
  /** Fields main stored differently from what the window sent (normalization, fences); the window
   *  can't assume its copy for them, so it sends them whole next time. */
  normalizedFields?: string[]
}

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
  const storedFields: Record<string, unknown> = stored
  const entries = isWorkspaceSessionRecord(patch?.entries) ? patch.entries : {}
  for (const [field, changes] of Object.entries(entries)) {
    if (!isFieldEntryChanges(changes)) {
      continue
    }
    const current = storedFields[field]
    const next: Record<string, unknown> = isWorkspaceSessionRecord(current) ? { ...current } : {}
    for (const key of changes.remove) {
      delete next[key]
    }
    Object.assign(next, changes.set)
    Reflect.set(whole, field, next)
  }
  return whole
}

/** The sent fields whose stored values main changed while saving. Only what the window sent is
 *  compared (whole fields, and the keys it set or removed), never the rest of the partition. */
export function fieldsStoredDifferently(
  stored: WorkspaceSessionState,
  patch: WorkspaceSessionEntriesPatch
): string[] {
  const differ: string[] = []
  const storedFields: Record<string, unknown> = stored
  const fields = isWorkspaceSessionRecord(patch?.fields) ? patch.fields : {}
  for (const [field, value] of Object.entries(fields)) {
    if (!structuralValuesEqual(storedFields[field], value)) {
      differ.push(field)
    }
  }
  const entries = isWorkspaceSessionRecord(patch?.entries) ? patch.entries : {}
  for (const [field, changes] of Object.entries(entries)) {
    if (!isFieldEntryChanges(changes)) {
      continue
    }
    const current = storedFields[field]
    const record = isWorkspaceSessionRecord(current) ? current : {}
    const same =
      changes.remove.every((key) => !Object.hasOwn(record, key)) &&
      Object.entries(changes.set).every(
        ([key, value]) => Object.hasOwn(record, key) && structuralValuesEqual(record[key], value)
      )
    if (!same) {
      differ.push(field)
    }
  }
  return differ
}
