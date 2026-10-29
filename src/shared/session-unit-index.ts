import {
  record,
  rawOwner,
  type SessionReferenceKind,
  type SessionUnitAddress
} from './session-unit-reference'
export type { SessionReferenceKind, SessionUnitAddress } from './session-unit-reference'
import type { TerminalTab } from './terminal-tab-types'
import { SessionFieldOrder } from './session-field-order'
import { WORKSPACE_SESSION_FIELD_OWNERSHIP } from './workspace-session-host-field-ownership'
import { getRepoIdFromWorktreeId } from './worktree/id'
import { parsePaneKey } from './stable-pane-id'
import { SESSION_MAP_FIELDS, type SessionMapField } from './session-change-set'

type Contribution = SessionUnitAddress & {
  references: Map<SessionReferenceKind, Set<string>>
  terminalOccurrences: Map<string, { count: number; first: unknown; last: unknown }>
  scrollbackOccurrences: Map<string, number>
  sourceFiles?: readonly unknown[]
}

export class SessionUnitIndex {
  private readonly units = new Map<SessionMapField, Map<string, Contribution>>()
  private readonly reverse = new Map<SessionReferenceKind, Map<string, Set<Contribution>>>()

  constructor(
    session: Partial<Record<SessionMapField, unknown>>,
    private readonly order = new SessionFieldOrder()
  ) {
    for (const field of SESSION_MAP_FIELDS) {
      for (const [key, value] of Object.entries(record(session[field]) ?? {})) {
        this.replace(field, key, value, true)
      }
    }
  }

  replace(
    field: SessionMapField,
    key: string,
    value: unknown,
    present = value !== undefined
  ): void {
    this.order.write(field, key, present)
    const byKey = this.units.get(field) ?? new Map<string, Contribution>()
    this.units.set(field, byKey)
    const prior = byKey.get(key)
    if (prior) {
      for (const [kind, ids] of prior.references) {
        for (const id of ids) {
          const byId = this.reverse.get(kind)
          const members = byId?.get(id)
          members?.delete(prior)
          if (members?.size === 0) {
            byId?.delete(id)
          }
        }
      }
      byKey.delete(key)
    }
    if (!present) {
      return
    }
    const unit: Contribution = {
      field,
      key,
      references: new Map(),
      terminalOccurrences: new Map(),
      scrollbackOccurrences: new Map()
    }
    if (field === 'openFilesByWorktree' && Array.isArray(value)) {
      unit.sourceFiles = value
    }
    const add = (kind: SessionReferenceKind, id: unknown): void => {
      if (typeof id !== 'string' || !id) {
        return
      }
      const ids = unit.references.get(kind) ?? new Set<string>()
      ids.add(id)
      unit.references.set(kind, ids)
    }
    const addOwner = (id: unknown): void => {
      if (typeof id === 'string') {
        add('owner', id)
        add('owner', rawOwner(id))
        add('repo', getRepoIdFromWorktreeId(rawOwner(id)))
        add('repo', getRepoIdFromWorktreeId(id.includes('|') ? id.slice(id.indexOf('|') + 1) : id))
      }
    }
    const ownership = WORKSPACE_SESSION_FIELD_OWNERSHIP[field]
    if (ownership === 'worktreeKeyed') {
      addOwner(key)
    } else if (ownership === 'tabKeyed') {
      add('tab', key)
    } else if (ownership === 'browserWorkspaceKeyed') {
      add('browser', key)
    } else if (ownership === 'fileKeyed') {
      add('file', key)
    } else if (
      ownership === 'paneKeyed' ||
      ownership === 'sleepingAgentKeyed' ||
      ownership === 'surfaceTombstoneKeyed'
    ) {
      add('pane', key)
      const separator = key.indexOf(':')
      if (separator > 0) {
        add('tab', key.slice(0, separator))
      }
      const pane = parsePaneKey(key)
      if (pane) {
        add('tab', pane.tabId)
        add('leaf', pane.leafId)
      }
    } else if (field === 'terminalTopologyRevisionByRepoId') {
      add('repo', key)
    }
    if (field === 'remoteSessionIdsByTabId') {
      add('pty', value)
    }
    if (field === 'tabsByWorktree' || field === 'unifiedTabs') {
      if (Array.isArray(value)) {
        for (const row of value) {
          const tab = record(row)
          addOwner(tab?.worktreeId)
          const tabId = tab?.id
          add('tab', tabId)
          if (tab?.contentType === 'terminal') {
            add('tab', tab.entityId)
          }
          add('pty', tab?.ptyId)
          if (field === 'tabsByWorktree' && typeof tabId === 'string') {
            const occurrence = unit.terminalOccurrences.get(tabId)
            unit.terminalOccurrences.set(tabId, {
              count: (occurrence?.count ?? 0) + 1,
              first: occurrence?.first ?? row,
              last: row
            })
          }
        }
      }
    } else if (
      field === 'openFilesByWorktree' ||
      field === 'browserTabsByWorktree' ||
      field === 'browserPagesByWorkspace'
    ) {
      if (Array.isArray(value)) {
        for (const row of value) {
          const item = record(row)
          addOwner(item?.worktreeId)
          addOwner(record(item?.docLocation)?.worktreeId)
          if (field === 'openFilesByWorktree') {
            add('file', item?.id)
            add('file', item?.filePath)
          } else if (field === 'browserTabsByWorktree') {
            add('browser', item?.id)
          } else {
            add('page', item?.id)
          }
        }
      }
    } else if (field === 'terminalLayoutsByTabId') {
      const layout = record(value)
      const visit = (node: unknown): void => {
        const part = record(node)
        if (part?.type === 'leaf') {
          add('leaf', part.leafId)
          if (typeof part.leafId === 'string') {
            add('pane', `${key}:${part.leafId}`)
          }
        } else if (part?.type === 'split') {
          visit(part.first)
          visit(part.second)
        }
      }
      visit(layout?.root)
      for (const pty of Object.values(record(layout?.ptyIdsByLeafId) ?? {})) {
        add('pty', pty)
      }
      for (const ref of Object.values(record(layout?.scrollbackRefsByLeafId) ?? {})) {
        add('scrollback', ref)
        if (typeof ref === 'string') {
          unit.scrollbackOccurrences.set(ref, (unit.scrollbackOccurrences.get(ref) ?? 0) + 1)
        }
      }
    } else {
      const rows = Array.isArray(value) ? value : [value]
      for (const row of rows) {
        const item = record(row)
        addOwner(item?.worktreeId)
        add('tab', item?.parentTabId ?? item?.tabId)
        add('pane', item?.paneKey)
        add('leaf', item?.leafId)
        add('pty', item?.ptyId)
      }
    }
    byKey.set(key, unit)
    for (const [kind, ids] of unit.references) {
      const byId = this.reverse.get(kind) ?? new Map<string, Set<Contribution>>()
      this.reverse.set(kind, byId)
      for (const id of ids) {
        const members = byId.get(id) ?? new Set<Contribution>()
        members.add(unit)
        byId.set(id, members)
      }
    }
  }

  references(kind: SessionReferenceKind, id: string): readonly SessionUnitAddress[] {
    return [...(this.reverse.get(kind)?.get(id) ?? [])]
      .sort(
        (left, right) =>
          SESSION_MAP_FIELDS.indexOf(left.field) - SESSION_MAP_FIELDS.indexOf(right.field) ||
          this.order.compare(left.field, left.key, right.key)
      )
      .map(({ field, key }) => ({ field, key }))
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
    return this.units.get(field)?.get(key)?.references.get(kind) ?? new Set()
  }

  fileOccurrences(owner: string): readonly unknown[] {
    return this.units.get('openFilesByWorktree')?.get(owner)?.sourceFiles ?? []
  }

  keys(field: SessionMapField): IterableIterator<string> {
    return this.ordered(field, (this.units.get(field) ?? new Map()).keys()).values()
  }

  has(field: SessionMapField, key: string): boolean {
    return this.units.get(field)?.has(key) ?? false
  }

  replaceField(
    field: SessionMapField,
    values: Readonly<Record<string, unknown>> | undefined
  ): void {
    for (const key of this.keys(field)) {
      this.replace(field, key, undefined)
    }
    for (const [key, value] of Object.entries(values ?? {})) {
      this.replace(field, key, value, true)
    }
  }

  orderField(field: SessionMapField, keys: readonly string[]): void {
    this.order.replace(field, keys)
  }

  size(field: SessionMapField): number {
    return this.units.get(field)?.size ?? 0
  }

  terminalOwner(tabId: string, selection: 'first' | 'last' = 'last'): string | undefined {
    const units = this.references('tab', tabId).filter((unit) => unit.field === 'tabsByWorktree')
    return selection === 'first' ? units[0]?.key : units.at(-1)?.key
  }

  terminalRow(
    owner: string,
    tabId: string,
    selection: 'first' | 'last' = 'first'
  ): TerminalTab | undefined {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: tabsByWorktree contributions retain the original admitted terminal DTO row.
    return this.units.get('tabsByWorktree')?.get(owner)?.terminalOccurrences.get(tabId)?.[
      selection
    ] as TerminalTab | undefined
  }

  terminalUnitOccurrenceCount(field: SessionMapField, key: string, tabId: string): number {
    return this.units.get(field)?.get(key)?.terminalOccurrences.get(tabId)?.count ?? 0
  }

  terminalOccurrenceCount(tabId: string): number {
    let count = 0
    for (const unit of this.reverse.get('tab')?.get(tabId) ?? []) {
      count += unit.terminalOccurrences.get(tabId)?.count ?? 0
    }
    return count
  }

  scrollbackRefs(): IterableIterator<string> {
    return (this.reverse.get('scrollback') ?? new Map()).keys()
  }

  scrollbackUnitCount(field: SessionMapField, key: string, ref: string): number {
    return this.units.get(field)?.get(key)?.scrollbackOccurrences.get(ref) ?? 0
  }

  scrollbackCount(ref: string): number {
    let count = 0
    for (const unit of this.reverse.get('scrollback')?.get(ref) ?? []) {
      count += unit.scrollbackOccurrences.get(ref) ?? 0
    }
    return count
  }

  candidate(): SessionUnitIndex {
    return new SessionUnitIndex(
      {
        tabsByWorktree: {},
        terminalLayoutsByTabId: {}
      },
      this.order.candidate()
    )
  }

  ordered(field: SessionMapField, keys: Iterable<string>): string[] {
    return this.order.ordered(field, keys)
  }
}
