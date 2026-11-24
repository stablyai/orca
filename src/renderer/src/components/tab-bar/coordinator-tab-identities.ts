import type { AppState } from '@/store/types'
import type { Tab } from '../../../../shared/workspace-layout/tab-groups/tab-types'
import type { AgentPublicIdentity } from '../../../../shared/orchestration/workers/worker-tab-stamp'
import { parsePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import { collectLayoutLeafIdsInOrder } from '../../../../shared/workspace-layout/terminal-topology/terminal-pane-tree'
import type { TerminalLayoutSnapshot } from '../../../../shared/workspace-layout/terminal-tab-types'
import { CoordinatorIdentityOwners } from './coordinator-identity-owners'

export type CoordinatorTabEntry = { tab: Tab; worktreeId: string }

export type IndexedCoordinatorTab = CoordinatorTabEntry & {
  position: number
  root: TerminalLayoutSnapshot['root'] | undefined
  leaves: readonly string[]
}

export class CoordinatorTabIdentityIndex {
  readonly entries = new Map<string, IndexedCoordinatorTab>()
  readonly workspaceOrder = new Map<string, number>()
  revision = 0
  private layouts: AppState['terminalLayoutsByTabId'] | undefined
  private readonly later = (left: IndexedCoordinatorTab, right: IndexedCoordinatorTab) =>
    (this.workspaceOrder.get(left.worktreeId) ?? 0) >
      (this.workspaceOrder.get(right.worktreeId) ?? 0) ||
    (left.worktreeId === right.worktreeId && left.position > right.position)
  private readonly aliases = new CoordinatorIdentityOwners(this.later)
  private readonly terminals = new CoordinatorIdentityOwners(this.later)
  private readonly leafOwners = new CoordinatorIdentityOwners(this.later)
  private readonly sessions = new CoordinatorIdentityOwners(this.later)

  upsert(state: AppState, tab: Tab, worktreeId: string, position: number): IndexedCoordinatorTab {
    const key = `${worktreeId}\0${tab.id}`
    const previous = this.entries.get(key)
    const root =
      tab.contentType === 'terminal' ? state.terminalLayoutsByTabId[tab.entityId]?.root : undefined
    const shapeChanged =
      !previous ||
      previous.tab.contentType !== tab.contentType ||
      previous.tab.entityId !== tab.entityId ||
      previous.tab.agentSessionLineageRootId !== tab.agentSessionLineageRootId ||
      previous.tab.workerTab?.origin.workerLeafId !== tab.workerTab?.origin.workerLeafId ||
      previous.root !== root
    if (previous && !shapeChanged && previous.tab === tab && previous.position === position) {
      return previous
    }
    if (previous && shapeChanged) {
      this.unindex(previous)
    }
    const entry = previous ?? { tab, worktreeId, position, root, leaves: [] }
    entry.tab = tab
    entry.position = position
    entry.root = root
    if (shapeChanged) {
      entry.leaves =
        tab.contentType !== 'terminal'
          ? []
          : root
            ? collectLayoutLeafIdsInOrder(root)
            : tab.workerTab?.origin.workerLeafId
              ? [tab.workerTab.origin.workerLeafId]
              : []
      this.entries.set(key, entry)
      this.index(entry)
    }
    this.revision++
    return entry
  }

  remove(entry: IndexedCoordinatorTab): void {
    this.unindex(entry)
    this.entries.delete(`${entry.worktreeId}\0${entry.tab.id}`)
    this.revision++
  }

  syncLayouts(state: AppState): void {
    if (this.layouts !== state.terminalLayoutsByTabId) {
      for (const entry of this.entries.values()) {
        const root =
          entry.tab.contentType === 'terminal'
            ? state.terminalLayoutsByTabId[entry.tab.entityId]?.root
            : undefined
        if (entry.root !== root) {
          this.upsert(state, entry.tab, entry.worktreeId, entry.position)
        }
      }
      this.layouts = state.terminalLayoutsByTabId
    }
  }

  byAlias(id: string): IndexedCoordinatorTab | undefined {
    return this.aliases.get(id)
  }

  forEachAlias(id: string, visit: (entry: IndexedCoordinatorTab) => void): void {
    this.aliases.forEach(id, visit)
  }

  byLeaf(id: string): IndexedCoordinatorTab | undefined {
    return this.leafOwners.get(id)
  }

  byTerminalEntity(id: string): IndexedCoordinatorTab | undefined {
    return this.terminals.get(id)
  }

  bySessionRoot(id: string): IndexedCoordinatorTab | undefined {
    return this.sessions.get(id)
  }

  resolve(identity: AgentPublicIdentity | undefined): IndexedCoordinatorTab | undefined {
    if (!identity) {
      return undefined
    }
    if (identity.kind === 'session') {
      return this.sessions.get(identity.lineageRootSessionId)
    }
    const pane = parsePaneKey(identity.paneKey)
    if (!pane) {
      return undefined
    }
    const owner = this.byLeaf(pane.leafId)
    const fallback = this.terminals.get(pane.tabId)
    return owner ?? (fallback && !fallback.root ? fallback : undefined)
  }

  private index(entry: IndexedCoordinatorTab): void {
    this.aliases.add(entry.tab.id, entry)
    this.aliases.add(entry.tab.entityId, entry)
    if (entry.tab.contentType === 'terminal') {
      this.terminals.add(entry.tab.entityId, entry)
      for (const leaf of entry.leaves) {
        this.leafOwners.add(leaf, entry)
      }
    } else if (entry.tab.contentType === 'agent-session') {
      this.sessions.add(entry.tab.agentSessionLineageRootId ?? entry.tab.entityId, entry)
    }
  }

  private unindex(entry: IndexedCoordinatorTab): void {
    this.aliases.remove(entry.tab.id, entry)
    this.aliases.remove(entry.tab.entityId, entry)
    if (entry.tab.contentType === 'terminal') {
      this.terminals.remove(entry.tab.entityId, entry)
      for (const leaf of entry.leaves) {
        this.leafOwners.remove(leaf, entry)
      }
    } else if (entry.tab.contentType === 'agent-session') {
      this.sessions.remove(entry.tab.agentSessionLineageRootId ?? entry.tab.entityId, entry)
    }
  }
}
