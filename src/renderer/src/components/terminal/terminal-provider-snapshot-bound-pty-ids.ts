import { readRecordChanges } from '@/store/keyed-record-change-reads'
import { createTerminalTabOwnerIndex } from '@/store/terminals/ownership/terminal-tab-owner-index'
import type { SnapshotCapabilityBindingState } from './terminal-provider-snapshot-capability'

type State = SnapshotCapabilityBindingState
type Source = {
  tabs: State['tabsByWorktree']
  bindings: State['ptyIdsByTabId']
  layouts: NonNullable<State['terminalLayoutsByTabId']>
  reconnect: NonNullable<State['pendingReconnectPtyIdByTabId']>
}
const EMPTY_LAYOUTS: Source['layouts'] = Object.freeze({})
const EMPTY_RECONNECT: Source['reconnect'] = Object.freeze({})

/** PTYs may belong to several sources; removing one binding must not prune another source's answer. */
export function createTerminalProviderSnapshotBoundPtyIdsSelector(): (state: State) => string[] {
  let previous: Source | null = null
  const tabOwners = createTerminalTabOwnerIndex()
  const workspacePtys = new Map<string, ReadonlySet<string>>()
  const layoutPtys = new Map<string, ReadonlySet<string>>()
  const reconnectPtys = new Map<string, ReadonlySet<string>>()
  const references = new Map<string, number>()
  let boundPtyIds: string[] = []
  let membershipChanged = false

  function replace(
    contributions: Map<string, ReadonlySet<string>>,
    key: string,
    next: ReadonlySet<string>
  ): void {
    const before = contributions.get(key)
    for (const id of before ?? []) {
      if (next.has(id)) {
        continue
      }
      const count = (references.get(id) ?? 0) - 1
      if (count > 0) {
        references.set(id, count)
      } else {
        references.delete(id)
        membershipChanged = true
      }
    }
    for (const id of next) {
      if (before?.has(id)) {
        continue
      }
      const count = references.get(id) ?? 0
      references.set(id, count + 1)
      membershipChanged ||= count === 0
    }
    if (next.size > 0) {
      contributions.set(key, next)
    } else {
      contributions.delete(key)
    }
  }

  function replaceWorkspace(source: Source, worktreeId: string): void {
    const ids = new Set<string>()
    for (const tab of source.tabs[worktreeId] ?? []) {
      if (tab.ptyId) {
        ids.add(tab.ptyId)
      }
      for (const id of source.bindings[tab.id] ?? []) {
        ids.add(id)
      }
    }
    replace(workspacePtys, worktreeId, ids)
  }

  function replaceLayout(source: Source, tabId: string): void {
    replace(layoutPtys, tabId, new Set(Object.values(source.layouts[tabId]?.ptyIdsByLeafId ?? {})))
  }

  function replaceReconnect(source: Source, tabId: string): void {
    const id = source.reconnect[tabId]
    replace(reconnectPtys, tabId, new Set(id !== undefined ? [id] : []))
  }

  function resyncUnknownSnapshot(source: Source): void {
    workspacePtys.clear()
    layoutPtys.clear()
    reconnectPtys.clear()
    references.clear()
    membershipChanged = true
    for (const id of Object.keys(source.tabs)) {
      replaceWorkspace(source, id)
    }
    for (const id of Object.keys(source.layouts)) {
      replaceLayout(source, id)
    }
    for (const id of Object.keys(source.reconnect)) {
      replaceReconnect(source, id)
    }
  }

  return (state) => {
    const source: Source = {
      tabs: state.tabsByWorktree,
      bindings: state.ptyIdsByTabId,
      layouts: state.terminalLayoutsByTabId ?? EMPTY_LAYOUTS,
      reconnect: state.pendingReconnectPtyIdByTabId ?? EMPTY_RECONNECT
    }
    const tabsChanges = previous ? readRecordChanges(source.tabs, previous.tabs) : null
    const changedWorkspaces =
      tabsChanges?.kind === 'addressed'
        ? tabsChanges.keys
        : previous?.tabs === source.tabs
          ? []
          : null
    const bindingsChanges = previous ? readRecordChanges(source.bindings, previous.bindings) : null
    const changedBindings =
      bindingsChanges?.kind === 'addressed'
        ? bindingsChanges.keys
        : previous?.bindings === source.bindings
          ? []
          : null
    const layoutsChanges = previous ? readRecordChanges(source.layouts, previous.layouts) : null
    const changedLayouts =
      layoutsChanges?.kind === 'addressed'
        ? layoutsChanges.keys
        : previous?.layouts === source.layouts
          ? []
          : null
    const reconnectChanges = previous
      ? readRecordChanges(source.reconnect, previous.reconnect)
      : null
    const changedReconnect =
      reconnectChanges?.kind === 'addressed'
        ? reconnectChanges.keys
        : previous?.reconnect === source.reconnect
          ? []
          : null
    tabOwners.getOwners(source.tabs)
    if (!changedWorkspaces || !changedBindings || !changedLayouts || !changedReconnect) {
      resyncUnknownSnapshot(source)
    } else {
      const worktreeIds = new Set(changedWorkspaces)
      for (const tabId of changedBindings) {
        for (const id of tabOwners.getOwnerIds(source.tabs, tabId)) {
          worktreeIds.add(id)
        }
      }
      for (const id of worktreeIds) {
        replaceWorkspace(source, id)
      }
      for (const id of changedLayouts) {
        replaceLayout(source, id)
      }
      for (const id of changedReconnect) {
        replaceReconnect(source, id)
      }
    }
    if (membershipChanged) {
      const next = [...references.keys()].sort()
      if (
        next.length !== boundPtyIds.length ||
        next.some((id, index) => id !== boundPtyIds[index])
      ) {
        boundPtyIds = next
      }
      membershipChanged = false
    }
    previous = source
    return boundPtyIds
  }
}
