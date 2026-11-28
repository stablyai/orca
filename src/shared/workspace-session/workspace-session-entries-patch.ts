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
  /** Keys of keyed record fields main stored differently; the window resends only those keys. */
  normalizedEntries?: Record<string, string[]>
  /** For relay ids sent with the patch (absent when none were): `refused` when main kept an id it
   *  holds in place of the window's. A skipped patch skipped them too. */
  relays?: 'applied' | 'unchanged' | 'refused'
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

export type WorkspaceSessionStoredDifferences = {
  fields: string[]
  entries: Record<string, string[]>
}

/** Sent keys main stored with another value or dropped. Keys main holds that the window didn't
 *  send, or kept after the window removed them, are main's own and don't make the field differ. */
function keysStoredDifferently(record: Record<string, unknown>, set: Record<string, unknown>) {
  return Object.keys(set).filter(
    (key) => !Object.hasOwn(record, key) || !structuralValuesEqual(record[key], set[key])
  )
}

/** What main stored differently from what the window sent: whole fields, or the keys of a keyed
 *  record. Only what the window sent is compared, never the rest of the partition. */
export function storedDifferently(
  stored: WorkspaceSessionState,
  patch: WorkspaceSessionEntriesPatch
): WorkspaceSessionStoredDifferences {
  const differ: WorkspaceSessionStoredDifferences = { fields: [], entries: {} }
  const storedFields: Record<string, unknown> = stored
  const noteKeys = (field: string, set: Record<string, unknown>) => {
    const current = storedFields[field]
    if (!isWorkspaceSessionRecord(current)) {
      differ.fields.push(field)
      return
    }
    const keys = keysStoredDifferently(current, set)
    if (keys.length > 0) {
      differ.entries[field] = keys
    }
  }
  const fields = isWorkspaceSessionRecord(patch?.fields) ? patch.fields : {}
  for (const [field, value] of Object.entries(fields)) {
    if (isWorkspaceSessionRecord(value)) {
      noteKeys(field, value)
    } else if (!structuralValuesEqual(storedFields[field], value)) {
      differ.fields.push(field)
    }
  }
  const entries = isWorkspaceSessionRecord(patch?.entries) ? patch.entries : {}
  for (const [field, changes] of Object.entries(entries)) {
    if (isFieldEntryChanges(changes) && Object.keys(changes.set).length > 0) {
      noteKeys(field, changes.set)
    }
  }
  return differ
}
