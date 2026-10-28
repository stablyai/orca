// Isolate command edits by diffing saves before/after the command; patch only those fields onto stored data so unrelated Loader normalizations remain unwritten.

import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../layout-owner-switch'
import type { WorkspaceSessionState } from '../workspace-session-state-types'
import { editorFileKey } from './workspace-layout-editor-tab-file'
import { adoptTouchedFoldedRows } from './workspace-layout-folded-rows'

type Json = Record<string, unknown>

/** Per-workspace lists of records, matched by id rather than replaced whole. */
const LIST_FIELDS: Record<string, (record: Json) => unknown> = {
  tabsByWorktree: (record) => record.id,
  unifiedTabs: (record) => record.id,
  tabGroups: (record) => record.id,
  // Why the switch: a local and a runtime-environment file can share a path in a layout-owner build.
  openFilesByWorktree: (record) =>
    ORCA_LAYOUT_OWNER_IS_MAIN && typeof record.filePath === 'string'
      ? editorFileKey({
          filePath: record.filePath,
          runtimeEnvironmentId:
            typeof record.runtimeEnvironmentId === 'string' ? record.runtimeEnvironmentId : null
        })
      : record.filePath,
  browserTabsByWorktree: (record) => record.id
}

// Patch session maps to record depth; changed record fields are replaced whole, matching diffStoredSession.
const MAP_RECORD_DEPTH = 2

/** Write touched records as after has them, including whole records supplied by load and touched folded legacy rows in loaded form. Preserve untouched stored records and return stored for a no-op. */
export function patchStoredSession(
  stored: WorkspaceSessionState,
  before: WorkspaceSessionState,
  after: WorkspaceSessionState
): WorkspaceSessionState {
  const patched = patchRecords(stored, before, after)
  const adopted = adoptTouchedFoldedRows(stored, patched, before)
  return adopted === stored ? patched : patchRecords(adopted, before, after)
}

function patchRecords(
  stored: WorkspaceSessionState,
  before: WorkspaceSessionState,
  after: WorkspaceSessionState
): WorkspaceSessionState {
  const beforeFields = toJson(before)
  const afterFields = toJson(after)
  const changed = changedKeys(beforeFields, afterFields)
  if (changed.length === 0) {
    return stored
  }
  const storedFields = toJson(stored)
  const patched: Json = { ...storedFields }
  for (const field of changed) {
    const idOf = LIST_FIELDS[field]
    // The command dropped the field: stored records the load never read go with it.
    if (afterFields[field] === undefined) {
      delete patched[field]
    } else if (idOf) {
      patched[field] = patchLists(
        asJson(storedFields[field]),
        asJson(beforeFields[field]),
        asJson(afterFields[field]),
        idOf
      )
    } else {
      patched[field] = patchValue(
        storedFields[field],
        beforeFields[field],
        afterFields[field],
        MAP_RECORD_DEPTH
      )
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every field is the stored session's own or copied from `after`, a WorkspaceSessionState.
  return patched as unknown as WorkspaceSessionState
}

function patchLists(
  stored: Json,
  before: Json,
  after: Json,
  idOf: (record: Json) => unknown
): Json {
  const patched: Json = { ...stored }
  for (const key of changedKeys(before, after)) {
    const list = patchList(asList(stored[key]), asList(before[key]), asList(after[key]), idOf)
    if (list.length === 0 && (after[key] === undefined || stored[key] === undefined)) {
      delete patched[key]
    } else {
      patched[key] = list
    }
  }
  return patched
}

function indexRecordsById(list: Json[], idOf: (record: Json) => unknown): Map<unknown, Json> {
  const records = new Map<unknown, Json>()
  for (const record of list) {
    const id = idOf(record)
    if (!records.has(id)) {
      records.set(id, record)
    }
  }
  return records
}

function patchList(stored: Json[], before: Json[], after: Json[], idOf: (record: Json) => unknown) {
  const beforeById = indexRecordsById(before, idOf)
  const afterById = indexRecordsById(after, idOf)
  const result = [...stored]
  const ids = new Set([...before.map(idOf), ...after.map(idOf)])
  const kept = (list: Json[], other: Json[]) => {
    const otherIds = new Set(other.map(idOf))
    return list.map(idOf).filter((id) => otherIds.has(id))
  }
  // Unchanged relative order means renumbering only closed a removed record’s gap.
  const renumberedOnly = sameJson(kept(before, after), kept(after, before))
  for (const id of ids) {
    const old = beforeById.get(id)
    const next = afterById.get(id)
    if (sameJson(old, next)) {
      continue
    }
    const index = result.findIndex((record) => idOf(record) === id)
    // Do not materialize load-supplied siblings that the command merely renumbered.
    if (
      index === -1 &&
      renumberedOnly &&
      old &&
      next &&
      sameJson({ ...old, sortOrder: 0 }, { ...next, sortOrder: 0 })
    ) {
      continue
    }
    if (!next) {
      if (index !== -1) {
        result.splice(index, 1)
      }
    } else if (index !== -1) {
      result[index] = asJson(patchValue(result[index], old, next, 1))
    } else {
      result.splice(insertionIndex(result, after, after.indexOf(next), idOf), 0, next)
    }
  }
  const order = (list: Json[]) => list.map(idOf).filter((id) => ids.has(id))
  if (sameJson(order(before), order(after))) {
    return result
  }
  // The command reordered its own records: they take `after`'s order in the slots they hold.
  const placed = new Set(after.map(idOf))
  const resultById = indexRecordsById(result, idOf)
  const queue = after
    .map((record) => resultById.get(idOf(record)))
    .filter((record): record is Json => record !== undefined)
  let nextIndex = 0
  return result.map((record) =>
    placed.has(idOf(record)) ? (queue[nextIndex++] ?? record) : record
  )
}

function insertionIndex(
  result: Json[],
  after: Json[],
  position: number,
  idOf: (record: Json) => unknown
): number {
  for (const preceding of after.slice(0, position).toReversed()) {
    const index = result.findIndex((record) => idOf(record) === idOf(preceding))
    if (index !== -1) {
      return index + 1
    }
  }
  return position === 0 ? 0 : result.length
}

function patchValue(stored: unknown, before: unknown, after: unknown, depth: number): unknown {
  // A record the stored partition lacks is written whole; a missing map is patched key by key.
  if (
    depth === 0 ||
    !isRecord(before) ||
    !isRecord(after) ||
    (!isRecord(stored) && depth !== MAP_RECORD_DEPTH)
  ) {
    return after
  }
  const base = asJson(stored)
  const patched: Json = { ...base }
  for (const key of changedKeys(before, after)) {
    if (after[key] === undefined) {
      delete patched[key]
    } else {
      patched[key] = patchValue(base[key], before[key], after[key], depth - 1)
    }
  }
  return patched
}

function changedKeys(before: Json, after: Json): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
    (key) => !sameJson(before[key], after[key])
  )
}

/** Deep equality where key order and undefined-valued keys do not count, as stableJson. */
function sameJson(left: unknown, right: unknown): boolean {
  if (left === right) {
    return true
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => sameJson(value, right[index]))
    )
  }
  if (!isRecord(left) || !isRecord(right)) {
    return false
  }
  const keys = new Set([...Object.keys(left), ...Object.keys(right)])
  return [...keys].every((key) => sameJson(left[key], right[key]))
}

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asJson(value: unknown): Json {
  return isRecord(value) ? value : {}
}

function asList(value: unknown): Json[] {
  return Array.isArray(value) ? value.filter(isRecord) : []
}

function toJson(session: WorkspaceSessionState): Json {
  return { ...session }
}
