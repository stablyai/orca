import type { RetainedTerminalStart } from '../../../../shared/workspace-layout/retained-terminal-start'
import { collectLeafIds } from '../../../../shared/workspace-layout/terminal-pane-layout-tree'
import { resolveRootlessTerminalLayoutLeafId } from '../../../../shared/workspace-layout/terminal-pane-tree'
import { resolveOwner } from '@/lib/workspace/ownership/resolve-owner'
import type { AppState } from '../types'
import type { TerminalLayoutSnapshot } from '../../../../shared/workspace-layout/terminal-tab-types'
import { parseExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'

type RestoredPane = {
  worktreeId: string
  hostId: ExecutionHostId | null
  binding: string | undefined
  movedDuringRead?: number
}
type BaselineTab = {
  worktreeId: string
  groupId: string | undefined
  layout: TerminalLayoutSnapshot | undefined
  binding: string | null
}

/** Only this hydration's provenance/unknown read lives here; start facts stay in the store. */
export class TerminalStartupAttempt {
  private unknown = new Map<string, Map<string, RestoredPane>>()
  private baseline = new Map<string, BaselineTab>()
  private retired = new Map<string, Set<string>>()
  private closedTabs = new Set<string>()
  private groups = new Map<string, Set<string>>()
  private rebound = new Map<string, Set<string>>()
  private disposed = false
  private captured = false
  private completed = false
  generation = 0
  private read = 0

  capture(state: AppState): void {
    this.generation++
    this.completed = false
    this.unknown.clear()
    this.baseline.clear()
    this.retired.clear()
    this.closedTabs.clear()
    this.groups.clear()
    this.rebound.clear()
    this.captured = true
    for (const [worktreeId, tabs] of Object.entries(state.tabsByWorktree ?? {})) {
      const hydratedHost = state.restoredRuntimeHostIdByWorkspaceSessionKey?.[worktreeId]
      if (hydratedHost && parseExecutionHostId(hydratedHost)?.kind === 'runtime') {
        continue
      }
      const ownership = resolveOwner(state, { workspaceId: worktreeId, hostId: hydratedHost })
      if (ownership.kind === 'resolved' && ownership.owner.endpoint.kind === 'environment') {
        continue
      }
      const hostId = ownership.kind === 'resolved' ? ownership.owner.at : null
      const groups = state.groupsByWorktree?.[worktreeId] ?? []
      this.groups.set(worktreeId, new Set(groups.map((group) => group.id)))
      const groupByTab = new Map(
        groups.flatMap((group) => group.tabOrder.map((id) => [id, group.id] as const))
      )
      for (const tab of tabs) {
        const layout = state.terminalLayoutsByTabId[tab.id]
        this.baseline.set(tab.id, {
          worktreeId,
          groupId: groupByTab.get(tab.id),
          layout,
          binding: tab.ptyId
        })
        const leafIds = layout?.root
          ? collectLeafIds(layout.root)
          : [resolveRootlessTerminalLayoutLeafId(layout ?? { activeLeafId: null })].filter(
              (id): id is string => id !== null
            )
        this.unknown.set(
          tab.id,
          new Map(
            leafIds.map((leafId) => [
              leafId,
              {
                worktreeId,
                hostId,
                binding: layout?.ptyIdsByLeafId?.[leafId] ?? tab.ptyId ?? undefined
              }
            ])
          )
        )
      }
    }
  }

  ensureCaptured(state: AppState): void {
    if (!this.captured) {
      this.capture(state)
    }
  }

  baselineTab(tabId: string): BaselineTab | undefined {
    return this.baseline.get(tabId)
  }
  hadGroup(worktreeId: string, groupId: string): boolean {
    return this.groups.get(worktreeId)?.has(groupId) === true
  }

  historicalBinding(tabId: string, leafId: string): string | undefined {
    const baseline = this.baseline.get(tabId)
    return (
      this.unknown.get(tabId)?.get(leafId)?.binding ??
      baseline?.layout?.ptyIdsByLeafId?.[leafId] ??
      baseline?.binding ??
      undefined
    )
  }

  beginRead(state: AppState): number {
    const owners = new Map<string, ExecutionHostId | null>()
    for (const members of this.unknown.values()) {
      for (const pane of members.values()) {
        if (!owners.has(pane.worktreeId)) {
          const owner = resolveOwner(state, {
            workspaceId: pane.worktreeId,
            hostId:
              state.restoredRuntimeHostIdByWorkspaceSessionKey?.[pane.worktreeId] ??
              pane.hostId ??
              undefined
          })
          owners.set(
            pane.worktreeId,
            owner.kind === 'resolved' && owner.owner.endpoint.kind === 'self'
              ? owner.owner.at
              : null
          )
        }
        pane.hostId = owners.get(pane.worktreeId) ?? null
      }
    }
    return ++this.read
  }
  hasUnknown(): boolean {
    return this.unknown.size !== 0
  }

  isComplete(): boolean {
    return this.completed && !this.disposed
  }

  isUnknown(worktreeId: string, tabId: string, leafId: string): boolean {
    return !this.disposed && this.unknown.get(tabId)?.get(leafId)?.worktreeId === worktreeId
  }

  wasRetired(tabId: string, leafId: string): boolean {
    return this.closedTabs.has(tabId) || this.retired.get(tabId)?.has(leafId) === true
  }

  wasRebound(tabId: string, leafId: string): boolean {
    return this.rebound.get(tabId)?.has(leafId) === true
  }

  acceptBinding(tabId: string, leafId: string): boolean {
    if (!this.completed && !this.disposed) {
      const leaves = this.rebound.get(tabId) ?? new Set<string>()
      leaves.add(leafId)
      this.rebound.set(tabId, leaves)
    }
    return this.settle(tabId, leafId)
  }

  settle(tabId: string, leafId: string): boolean {
    const members = this.unknown.get(tabId)
    const changed = members?.delete(leafId) === true
    if (members?.size === 0) {
      this.unknown.delete(tabId)
    }
    return changed
  }

  close(tabId: string, leafId?: string): void {
    if (this.completed || this.disposed) {
      return
    }
    if (leafId === undefined) {
      this.closedTabs.add(tabId)
      this.unknown.delete(tabId)
    } else {
      const retired = this.retired.get(tabId) ?? new Set<string>()
      retired.add(leafId)
      this.retired.set(tabId, retired)
      this.settle(tabId, leafId)
    }
  }

  layoutChanged(
    tabId: string,
    before: TerminalLayoutSnapshot | undefined,
    after: TerminalLayoutSnapshot | null
  ): void {
    const remaining = new Set(collectLeafIds(after?.root))
    for (const leafId of collectLeafIds(before?.root)) {
      if (!remaining.has(leafId)) {
        this.close(tabId, leafId)
      }
    }
    // A historical hint is unchanged; only a newly accepted binding settles the read.
    for (const [leafId, binding] of Object.entries(after?.ptyIdsByLeafId ?? {})) {
      if (
        binding &&
        binding !== before?.ptyIdsByLeafId?.[leafId] &&
        binding !== this.unknown.get(tabId)?.get(leafId)?.binding
      ) {
        this.acceptBinding(tabId, leafId)
      }
    }
  }

  transfer(fromTabId: string, toTabId: string, leafId: string): void {
    if (this.completed || this.disposed) {
      return
    }
    const pane = this.unknown.get(fromTabId)?.get(leafId)
    if (fromTabId === toTabId) {
      return
    }
    if (pane) {
      const target = this.unknown.get(toTabId) ?? new Map<string, RestoredPane>()
      target.set(leafId, { ...pane, movedDuringRead: this.read })
      this.unknown.set(toTabId, target)
    }
    this.retired.get(toTabId)?.delete(leafId)
    this.closedTabs.delete(toTabId)
    this.close(fromTabId, leafId)
  }

  keepUnknown(start: RetainedTerminalStart): void {
    if (
      this.disposed ||
      this.wasRetired(start.tabId, start.leafId) ||
      this.wasRebound(start.tabId, start.leafId)
    ) {
      return
    }
    const members = this.unknown.get(start.tabId) ?? new Map<string, RestoredPane>()
    if (!members.has(start.leafId)) {
      members.set(start.leafId, {
        worktreeId: start.worktreeId,
        hostId: start.executionHostId,
        binding: undefined
      })
      this.unknown.set(start.tabId, members)
    }
  }

  settleAll(read: number, state: AppState, unresolved: ReadonlySet<string> = new Set()): void {
    const owners = new Map<string, ExecutionHostId | null>()
    for (const [tabId, members] of this.unknown) {
      for (const [leafId, pane] of members) {
        if (!owners.has(pane.worktreeId)) {
          const owner = resolveOwner(state, {
            workspaceId: pane.worktreeId,
            hostId:
              state.restoredRuntimeHostIdByWorkspaceSessionKey?.[pane.worktreeId] ??
              pane.hostId ??
              undefined
          })
          owners.set(
            pane.worktreeId,
            owner.kind === 'resolved' && owner.owner.endpoint.kind === 'self'
              ? owner.owner.at
              : null
          )
        }
        if (
          !unresolved.has(`${tabId}:${leafId}`) &&
          pane.hostId !== null &&
          pane.hostId === owners.get(pane.worktreeId) &&
          pane.movedDuringRead !== read
        ) {
          members.delete(leafId)
        }
      }
      if (members.size === 0) {
        this.unknown.delete(tabId)
      }
    }
    if (this.unknown.size === 0) {
      this.completed = true
      this.baseline.clear()
      this.retired.clear()
      this.closedTabs.clear()
      this.groups.clear()
      this.rebound.clear()
    }
  }
  dispose(): void {
    this.generation++
    this.disposed = true
    this.unknown.clear()
    this.baseline.clear()
    this.retired.clear()
    this.closedTabs.clear()
    this.groups.clear()
    this.rebound.clear()
  }
}
