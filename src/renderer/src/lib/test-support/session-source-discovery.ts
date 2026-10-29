import type { AppState } from '../../store/types'
import type { OpenFile } from '../../store/slices/editor'
import {
  SESSION_SOURCE_FIELDS,
  groupSessionFiles,
  groupSessionCatalog,
  type SessionSourceField,
  type SessionSourceDiscovery
} from '../session-source-fields'
export * from '../session-source-fields'

type SourceCollection = Readonly<Record<string, unknown>> | Map<string, unknown>

function isSourceArray(
  value: AppState[SessionSourceField]
): value is Extract<AppState[SessionSourceField], readonly unknown[]> {
  return Array.isArray(value)
}

function sourceKeys(value: SourceCollection): string[] {
  return value instanceof Map ? [...value.keys()] : Object.keys(value)
}
function sourceHas(value: SourceCollection, key: string): boolean {
  return value instanceof Map ? value.has(key) : Object.hasOwn(value, key)
}
function sourceValue(value: SourceCollection, key: string): unknown {
  return value instanceof Map ? value.get(key) : value[key]
}
function isIntegerProperty(key: string): boolean {
  const numeric = Number(key)
  return (
    Number.isInteger(numeric) && numeric >= 0 && numeric < 4_294_967_295 && String(numeric) === key
  )
}

function compareRecordSources(
  before: SourceCollection,
  after: SourceCollection
): { keys: Set<string>; reordered: boolean } {
  const newKeys = Object.keys(after)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this branch handles own string-keyed Records, after excluding Maps/arrays/Sets.
  const prior = before as Readonly<Record<string, unknown>>
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the same checked source domain applies to the candidate.
  const candidate = after as Readonly<Record<string, unknown>>
  const keys = new Set<string>()
  let aligned = true,
    position = 0
  for (const key in prior) {
    if (!Object.hasOwn(prior, key)) {
      continue
    }
    if (key !== newKeys[position++]) {
      aligned = false
      break
    }
    if (prior[key] !== candidate[key]) {
      keys.add(key)
    }
  }
  if (aligned && position === newKeys.length) {
    return { keys, reordered: false }
  }
  keys.clear()
  const oldKeys = Object.keys(before)
  let oldStrings = 0,
    nextString = 0
  while (oldStrings < oldKeys.length && isIntegerProperty(oldKeys[oldStrings])) {
    oldStrings++
  }
  while (nextString < newKeys.length && isIntegerProperty(newKeys[nextString])) {
    nextString++
  }
  const firstNewString = nextString
  let reordered = false
  for (let i = 0; i < oldKeys.length; i++) {
    const key = oldKeys[i]
    const present = key === newKeys[i] || Object.hasOwn(after, key)
    if (!present || candidate[key] !== prior[key]) {
      keys.add(key)
    }
    if (present && i >= oldStrings && key !== newKeys[nextString++]) {
      reordered = true
    }
  }
  for (let i = 0; i < newKeys.length; i++) {
    const key = newKeys[i]
    if (key !== oldKeys[i] && !Object.hasOwn(before, key)) {
      keys.add(key)
      if (i >= firstNewString && key !== newKeys[nextString++]) {
        reordered = true
      }
    }
  }
  return { keys, reordered }
}

/** Discovery compares source identities once per flush; ACKs have a separate baseline. */
export function discoverSessionSources(
  previous: Partial<AppState>,
  next: Partial<AppState>,
  fields: Iterable<SessionSourceField> = SESSION_SOURCE_FIELDS
): SessionSourceDiscovery {
  const changes = new Map<SessionSourceField, ReadonlySet<string> | null>()
  let full = false
  let filesByOwner: Map<string, OpenFile[]> | undefined
  const catalogs: NonNullable<SessionSourceDiscovery['sequences']> = {}
  for (const field of fields) {
    const before = previous[field],
      after = next[field]
    if (before === after && Object.hasOwn(previous, field) === Object.hasOwn(next, field)) {
      continue
    }
    if (field === 'openFiles') {
      const prior = groupSessionFiles(previous.openFiles ?? [])
      filesByOwner = groupSessionFiles(next.openFiles ?? [])
      const owners = new Set<string>()
      for (const [owner, rows] of prior) {
        const current = filesByOwner.get(owner)
        if (
          !current ||
          rows.length !== current.length ||
          rows.some((row, i) => row !== current[i])
        ) {
          owners.add(owner)
        }
      }
      for (const owner of filesByOwner.keys()) {
        if (!prior.has(owner)) {
          owners.add(owner)
        }
      }
      changes.set(field, owners)
    } else if (field === 'repos' || field === 'folderWorkspaces' || field === 'projectGroups') {
      const discover = <T extends { id: string }>(oldRows: readonly T[], newRows: readonly T[]) => {
        const prior = groupSessionCatalog(oldRows),
          current = groupSessionCatalog(newRows)
        const keys = new Set<string>()
        for (const [id, rows] of prior) {
          const entries = current.get(id)
          if (
            !entries ||
            entries.length !== rows.length ||
            rows.some((row, i) => row !== entries[i])
          ) {
            keys.add(id)
          }
        }
        for (const id of current.keys()) {
          if (!prior.has(id)) {
            keys.add(id)
          }
        }
        const applied = [...prior.keys()].filter((id) => current.has(id))
        for (const id of current.keys()) {
          if (!prior.has(id)) {
            applied.push(id)
          }
        }
        const ordered = [...current.keys()]
        if (applied.some((id, i) => id !== ordered[i])) {
          full = true
        }
        changes.set(field, keys)
        return current
      }
      if (field === 'repos') {
        catalogs.repos = discover(previous.repos ?? [], next.repos ?? [])
      } else if (field === 'folderWorkspaces') {
        catalogs.folderWorkspaces = discover(
          previous.folderWorkspaces ?? [],
          next.folderWorkspaces ?? []
        )
      } else {
        catalogs.projectGroups = discover(previous.projectGroups ?? [], next.projectGroups ?? [])
      }
    } else if (
      !before ||
      !after ||
      typeof before !== 'object' ||
      typeof after !== 'object' ||
      isSourceArray(before) ||
      isSourceArray(after) ||
      before instanceof Set ||
      after instanceof Set
    ) {
      changes.set(field, null)
    } else if (!(before instanceof Map) && !(after instanceof Map)) {
      const comparison = compareRecordSources(before, after)
      changes.set(field, comparison.keys)
      full ||= comparison.reordered
    } else {
      const oldKeys = sourceKeys(before),
        newKeys = sourceKeys(after)
      const keys = new Set<string>()
      for (const key of oldKeys) {
        if (!sourceHas(after, key) || sourceValue(after, key) !== sourceValue(before, key)) {
          keys.add(key)
        }
      }
      for (const key of newKeys) {
        if (!sourceHas(before, key)) {
          keys.add(key)
        }
      }
      const appliedOrder = oldKeys.filter((key) => sourceHas(after, key))
      for (const key of newKeys) {
        if (!sourceHas(before, key)) {
          appliedOrder.push(key)
        }
      }
      // Integer Record properties sort automatically; Map keys retain insertion order.
      const ordered =
        after instanceof Map ? newKeys : newKeys.filter((key) => !isIntegerProperty(key))
      const applied =
        after instanceof Map ? appliedOrder : appliedOrder.filter((key) => !isIntegerProperty(key))
      if (applied.some((key, i) => key !== ordered[i])) {
        full = true
      }
      changes.set(field, keys)
    }
  }
  return { changes, full, sequences: { ...catalogs, openFiles: filesByOwner } }
}
