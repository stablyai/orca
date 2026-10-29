import type { WorkspaceSessionState } from './workspace-session-state-types'
import { SessionFieldReader } from './session-reader-fields'
import { SESSION_MAP_FIELDS, type SessionMapField } from './session-change-set'
import type { SessionReferenceKind, SessionUnitAddress } from './session-unit-index'
import { workspaceSessionEntryOwner } from './workspace-session-stranded-partition-adoption'

export class SessionReaderQueries extends SessionFieldReader {
  private ownerRevision = -1
  private readonly ownerCache = new Map<string, string | undefined>()

  keys(field: SessionMapField): readonly string[] {
    const transition = this.transitions.get(field)
    const keys = transition?.complete ? this.candidateIndex.keys(field) : this.index.keys(field)
    return this.ordered(field, new Set([...keys, ...(transition?.entries?.keys() ?? [])]))
  }

  ids(
    field: SessionMapField,
    key: string,
    kind: Exclude<SessionReferenceKind, 'owner'>
  ): ReadonlySet<string> {
    return this.dependencyIds(field, key, kind)
  }

  dependencyIds(
    field: SessionMapField,
    key: string,
    kind: SessionReferenceKind
  ): ReadonlySet<string> {
    return new Set([
      ...this.index.dependencyIds(field, key, kind),
      ...this.candidateIndex.dependencyIds(field, key, kind)
    ])
  }

  ordered(field: SessionMapField, keys: Iterable<string>): readonly string[] {
    return this.orderSelection(
      field,
      [...keys].filter((key) => this.unit(field, key).present)
    )
  }

  orderSelection(field: SessionMapField, keys: Iterable<string>): readonly string[] {
    return this.candidateIndex.ordered(field, keys)
  }

  terminalOwners(tabId: string, phase: 'prior' | 'candidate' = 'candidate'): readonly string[] {
    return this.references('tab', tabId, phase)
      .filter((unit) => unit.field === 'tabsByWorktree')
      .map((unit) => unit.key)
  }

  terminalOwner(
    tabId: string,
    selection: 'first' | 'last' = 'last',
    phase: 'prior' | 'candidate' = 'candidate'
  ): string | undefined {
    const owners = this.terminalOwners(tabId, phase)
    return selection === 'first' ? owners[0] : owners.at(-1)
  }

  terminalTab(
    tabId: string,
    selection: 'first' | 'last' = 'first',
    phase: 'prior' | 'candidate' = 'candidate'
  ) {
    const owner = this.terminalOwner(tabId, selection, phase)
    if (owner === undefined) {
      return undefined
    }
    const index =
      phase === 'candidate' && this.changed.get('tabsByWorktree')?.has(owner)
        ? this.candidateIndex
        : this.index
    return index.terminalRow(owner, tabId, selection)
  }

  replayTerminalOwner(tabId: string): string | undefined {
    const owners = new Set([...this.terminalOwners(tabId, 'prior'), ...this.terminalOwners(tabId)])
    let owner: string | undefined
    for (const key of this.orderSelection('tabsByWorktree', owners)) {
      const rows =
        this.unit('tabsByWorktree', key).value ?? this.unit('tabsByWorktree', key, 'prior').value
      if (rows?.some((tab) => tab.id === tabId)) {
        owner = key
      }
    }
    return owner
  }

  references(
    kind: SessionReferenceKind,
    id: string,
    phase: 'prior' | 'candidate' = 'candidate'
  ): readonly SessionUnitAddress[] {
    if (phase === 'prior') {
      return this.index.references(kind, id)
    }
    const combined = [
      ...this.index
        .references(kind, id)
        .filter((unit) => !this.changed.get(unit.field)?.has(unit.key)),
      ...this.candidateIndex.references(kind, id)
    ]
    return combined.sort((a, b) => {
      if (a.field !== b.field) {
        return SESSION_MAP_FIELDS.indexOf(a.field) - SESSION_MAP_FIELDS.indexOf(b.field)
      }
      if (a.key === b.key) {
        return 0
      }
      return this.orderSelection(a.field, [a.key, b.key])[0] === a.key ? -1 : 1
    })
  }

  map<F extends SessionMapField>(
    field: F,
    keys: Iterable<string>
  ): NonNullable<WorkspaceSessionState[F]> {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every value is read from this exact typed session map field.
    return Object.fromEntries(
      this.ordered(field, keys).flatMap((key) => {
        const entry = this.unit(field, key)
        return entry.present ? [[key, entry.value]] : []
      })
    ) as NonNullable<WorkspaceSessionState[F]>
  }

  terminalOccurrenceCount(tabId: string, phase: 'prior' | 'candidate' = 'candidate'): number {
    if (phase === 'prior') {
      return this.index.terminalOccurrenceCount(tabId)
    }
    let count = this.candidateIndex.terminalOccurrenceCount(tabId)
    for (const unit of this.index.references('tab', tabId)) {
      if (unit.field === 'tabsByWorktree' && !this.changed.get(unit.field)?.has(unit.key)) {
        count += this.index.terminalUnitOccurrenceCount(unit.field, unit.key, tabId)
      }
    }
    return count
  }

  dataOwner(
    field: SessionMapField,
    key: string,
    phase: 'prior' | 'candidate' = 'candidate',
    selection: 'first' | 'last' = 'last'
  ): string | undefined {
    if (this.ownerRevision !== this.revision) {
      this.ownerCache.clear()
      this.ownerRevision = this.revision
    }
    const address = JSON.stringify([field, key, phase, selection])
    if (this.ownerCache.has(address)) {
      return this.ownerCache.get(address)
    }
    const owner =
      workspaceSessionEntryOwner(
        field,
        {
          get: (id) => this.tabDataOwner(id, phase, selection)
        },
        {
          get: (id) => {
            let owner: string | undefined
            for (const unit of this.references('file', id, phase)) {
              if (unit.field !== 'openFilesByWorktree') {
                continue
              }
              for (const file of this.unit(unit.field, unit.key, phase).value ?? []) {
                if (file.filePath === id) {
                  owner = file.worktreeId
                  if (selection === 'first') {
                    return owner
                  }
                }
              }
            }
            return owner
          }
        }
      )?.(key, this.unit(field, key, phase).value) ?? undefined
    this.ownerCache.set(address, owner)
    return owner
  }

  tabDataOwner(
    tabId: string,
    phase: 'prior' | 'candidate' = 'candidate',
    selection: 'first' | 'last' = 'last'
  ): string | undefined {
    const terminal = this.terminalOwner(tabId, selection, phase)
    if (terminal !== undefined) {
      return terminal
    }
    for (const unit of this.references('tab', tabId, phase)) {
      if (unit.field === 'unifiedTabs') {
        const row = this.unit(unit.field, unit.key, phase).value?.find((tab) => tab.id === tabId)
        if (row) {
          return row.worktreeId
        }
      }
    }
    return undefined
  }
}
