import type {
  SessionUnitIndex,
  SessionReferenceKind,
  SessionUnitAddress
} from './session-unit-index'
import { SESSION_MAP_FIELDS, type SessionMapField } from './session-change-set'
import { WORKSPACE_SESSION_FIELD_OWNERSHIP } from './workspace-session-host-field-ownership'

import type { SessionUnitReader } from './session-unit-reader'
export type SessionUnitSelection = Map<SessionMapField, Set<string>>
export type SessionOperationRoot = { kind: SessionReferenceKind; id: string }

export type SessionDependencySource = {
  index: { keys(field: SessionMapField): Iterable<string> }
  keys(field: SessionMapField): Iterable<string>
  changedKeys(field: SessionMapField): Iterable<string>
  dependencyIds(
    field: SessionMapField,
    key: string,
    kind: SessionReferenceKind
  ): ReadonlySet<string>
  references(
    kind: SessionReferenceKind,
    id: string,
    phase?: 'prior' | 'candidate'
  ): readonly SessionUnitAddress[]
  unitChanged(field: SessionMapField, key: string): boolean
  orderSelection(field: SessionMapField, keys: Iterable<string>): readonly string[]
}

export function resolveSessionUnits(
  reader: SessionDependencySource,
  extra: readonly SessionUnitAddress[] = [],
  full = false,
  includeChanges = true,
  roots: readonly SessionOperationRoot[] = []
): SessionUnitSelection {
  const operationAddresses = roots.flatMap(({ kind, id }) => [
    ...reader.references(kind, id, 'prior'),
    ...reader.references(kind, id),
    ...(kind === 'owner' || kind === 'tab'
      ? SESSION_MAP_FIELDS.filter(
          (field) =>
            WORKSPACE_SESSION_FIELD_OWNERSHIP[field] ===
            (kind === 'owner' ? 'worktreeKeyed' : 'tabKeyed')
        ).map((field) => ({ field, key: id }))
      : []),
    ...(kind === 'repo' ? [{ field: 'terminalTopologyRevisionByRepoId' as const, key: id }] : [])
  ])
  const selected: SessionUnitSelection = new Map()
  if (full) {
    for (const field of SESSION_MAP_FIELDS) {
      selected.set(field, new Set([...reader.index.keys(field), ...reader.keys(field)]))
    }
    for (const { field, key } of [...extra, ...operationAddresses]) {
      selected.get(field)!.add(key)
    }
    const revisions = selected.get('terminalTopologyRevisionByRepoId')!
    for (const [field, keys] of selected) {
      for (const key of keys) {
        for (const repo of reader.dependencyIds(field, key, 'repo')) {
          revisions.add(repo)
        }
      }
    }
    for (const [field, keys] of selected) {
      selected.set(field, new Set(reader.orderSelection(field, keys)))
    }
    return selected
  }
  const queue = [...extra, ...operationAddresses]
  const repoRoots = new Set(roots.filter((root) => root.kind === 'repo').map((root) => root.id))
  const visitedReferences = new Map<SessionReferenceKind, Set<string>>()
  const follow = (kind: SessionReferenceKind, id: string): void => {
    const visited = visitedReferences.get(kind) ?? new Set<string>()
    if (visited.has(id)) {
      return
    }
    visited.add(id)
    visitedReferences.set(kind, visited)
    queue.push(...reader.references(kind, id, 'prior'), ...reader.references(kind, id))
  }
  for (const field of includeChanges ? SESSION_MAP_FIELDS : []) {
    const keys = reader.changedKeys(field)
    for (const key of keys) {
      if (reader.unitChanged(field, key)) {
        queue.push({ field, key })
      }
    }
  }
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const { field, key } = queue[cursor]
    const keys = selected.get(field) ?? new Set<string>()
    if (keys.has(key)) {
      continue
    }
    keys.add(key)
    selected.set(field, keys)
    for (const kind of [
      'owner',
      'tab',
      'pane',
      'file',
      'page',
      'browser',
      'pty',
      'leaf'
    ] as const) {
      for (const id of reader.dependencyIds(field, key, kind)) {
        follow(kind, id)
      }
    }
    for (const repo of reader.dependencyIds(field, key, 'repo')) {
      queue.push({ field: 'terminalTopologyRevisionByRepoId', key: repo })
    }
    if (
      field === 'terminalTopologyRevisionByRepoId' &&
      (reader.unitChanged(field, key) || repoRoots.has(key))
    ) {
      follow('repo', key)
    }
  }
  for (const [field, keys] of selected) {
    selected.set(field, new Set(reader.orderSelection(field, keys)))
  }
  return selected
}

export function selectSessionUnits(
  reader: SessionUnitReader,
  extra: readonly SessionUnitAddress[] = [],
  full = false
): SessionUnitSelection {
  return reader.selection(extra, full)
}

export function selectIndexedSessionUnits(
  index: SessionUnitIndex,
  seeds: readonly SessionUnitAddress[]
) {
  return resolveSessionUnits(
    {
      index,
      keys: (field) => index.keys(field),
      changedKeys: () => [],
      dependencyIds: (field, key, kind) => index.dependencyIds(field, key, kind),
      references: (kind, id) => index.references(kind, id),
      unitChanged: () => false,
      orderSelection: (field, keys) => index.ordered(field, keys)
    },
    seeds
  )
}

export function indexedSessionOwners(index: SessionUnitIndex, selection: SessionUnitSelection) {
  const owners = new Set<string>()
  for (const [field, keys] of selection) {
    for (const key of keys) {
      for (const owner of index.dependencyIds(field, key, 'owner')) {
        owners.add(owner)
      }
    }
  }
  return owners
}

export function* indexedSessionTerminalTabIds(
  index: SessionUnitIndex,
  selection: SessionUnitSelection
): IterableIterator<string> {
  for (const owner of selection.get('tabsByWorktree') ?? []) {
    yield* index.ids('tabsByWorktree', owner, 'tab')
  }
}
