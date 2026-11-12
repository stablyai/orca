import type { AppState } from '@/store/types'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  isAgentStatusFresh
} from '../../../../shared/agent-status/contracts/agent-status-freshness'
import { getStructuredAgentSessionTabsByPaneKey } from '@/components/native-chat/session/status/structured-agent-session-tabs'
import { parsePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import { getTabIdToWorktreeId } from './workspace-card/activity/worktree-agent-row-selectors'
import { selectWorktreeAgentOrchestrationIndex } from './workspace-card/activity/worktree-agent-orchestration-index'
import { worktreeAgentProjectionInputs } from './workspace-card/activity/worktree-agent-rows-projection'
import { structuredAgentSessionOwnerInputs } from '@/runtime/native-chat/session-ownership/structured-agent-session-owner'
import { selectWorktreesByRepo } from '@/store/workspaces/catalog/workspace-record-fields'
import {
  addChangedLayoutWorkspaces,
  forEachChangedKey,
  type SlotLayout
} from './worktree-card-slot-layout-invalidation'

export type SlotSnapshot = {
  inputs: readonly unknown[]
  layout: SlotLayout
  /**
   * Orchestration links reach across workspaces (a child pane shows on its parent's workspace,
   * host aliasing reads tab and pty provenance), so it is diffed by its per-workspace output.
   */
  orchestration: ReturnType<typeof selectWorktreeAgentOrchestrationIndex>
  worktreesByRepo: AppState['worktreesByRepo']
  /** Workspace selection, settings and catalog: only consulted for chats with no stamped host. */
  owner: readonly unknown[]
  live: AppState['agentStatusByPaneKey']
  acknowledgements: AppState['acknowledgedAgentsByPaneKey']
  titles: AppState['runtimePaneTitlesByTabId']
  epoch: number
  at: number
}
let current: SlotSnapshot | undefined
export function slotSnapshot(state: AppState): SlotSnapshot {
  const inputs = worktreeAgentProjectionInputs(state)
  if (!current || !inputs.every((value, index) => value === current!.inputs[index])) {
    current = {
      inputs,
      layout: {
        tabsByWorktree: state.tabsByWorktree,
        unifiedTabsByWorktree: state.unifiedTabsByWorktree,
        migrationUnsupportedByPtyId: state.migrationUnsupportedByPtyId,
        retainedAgentsByPaneKey: state.retainedAgentsByPaneKey,
        ptyIdsByTabId: state.ptyIdsByTabId,
        terminalLayoutsByTabId: state.terminalLayoutsByTabId,
        runtimeAgentOrchestrationByPaneKey: state.runtimeAgentOrchestrationByPaneKey,
        paneForegroundAgentByPaneKey: state.paneForegroundAgentByPaneKey
      },
      orchestration: selectWorktreeAgentOrchestrationIndex(state),
      worktreesByRepo: selectWorktreesByRepo(state),
      owner: structuredAgentSessionOwnerInputs(state),
      live: state.agentStatusByPaneKey,
      acknowledgements: state.acknowledgedAgentsByPaneKey,
      titles: state.runtimePaneTitlesByTabId,
      epoch: state.agentStatusEpoch,
      at: current?.epoch === state.agentStatusEpoch ? current.at : Date.now()
    }
  }
  return current
}
function sameInputs(left: readonly unknown[], right: readonly unknown[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

/** Workspaces whose catalog rows were added, removed or replaced; untouched repos are skipped. */
function addChangedCatalogWorkspaces(
  result: Set<string>,
  before: AppState['worktreesByRepo'],
  after: AppState['worktreesByRepo']
): void {
  forEachChangedKey(before, after, (repoId) => {
    const previous = before[repoId] ?? []
    const next = after[repoId] ?? []
    const previousRows = new Set(previous)
    const nextRows = new Set(next)
    for (const row of next) {
      if (!previousRows.has(row)) {
        result.add(row.id)
      }
    }
    for (const row of previous) {
      if (!nextRows.has(row)) {
        result.add(row.id)
      }
    }
  })
}

/**
 * Chats without a stamped host resolve their owner from the workspace catalog and selection
 * (to disambiguate same-ID twins); only their workspaces can change when those inputs do.
 */
function addUnstampedChatWorkspaces(result: Set<string>, state: AppState): void {
  for (const tab of getStructuredAgentSessionTabsByPaneKey(state.unifiedTabsByWorktree).values()) {
    if (!tab.executionHostId) {
      result.add(tab.worktreeId)
    }
  }
}

function addChangedOrchestrationWorkspaces(
  result: Set<string>,
  before: SlotSnapshot['orchestration'],
  after: SlotSnapshot['orchestration']
): void {
  if (before === after) {
    return
  }
  // The index reuses an unchanged workspace's record, so identity marks what moved.
  for (const [worktreeId, record] of after) {
    if (before.get(worktreeId) !== record) {
      result.add(worktreeId)
    }
  }
  for (const worktreeId of before.keys()) {
    if (!after.has(worktreeId)) {
      result.add(worktreeId)
    }
  }
}

/**
 * Adds the workspaces a layout change can touch. Returns false when the change moved panes between
 * workspaces (a tab or chat added, removed or moved, or a pane in a tab no workspace owns): only
 * then must every slot be re-checked.
 */
const changes = new WeakMap<SlotSnapshot, WeakMap<SlotSnapshot, Set<string> | null>>()

export function changedSlotWorkspaces(
  state: AppState,
  before: SlotSnapshot,
  after: SlotSnapshot
): Set<string> | null {
  const cached = changes.get(before)?.get(after)
  if (cached !== undefined) {
    return cached
  }
  let result: Set<string> | null = new Set<string>()
  const tabOwners = getTabIdToWorktreeId(state.tabsByWorktree)
  const represented = getStructuredAgentSessionTabsByPaneKey(state.unifiedTabsByWorktree)
  const includePane = (paneKey: string): void => {
    const parsed = parsePaneKey(paneKey)
    const tabOwner = parsed && tabOwners.get(parsed.tabId)
    if (tabOwner) {
      result!.add(tabOwner)
    }
    // Structured sessions may have no backing terminal tab.
    const chat = represented.get(paneKey)
    if (chat) {
      result!.add(chat.worktreeId)
    }
    for (const entry of [
      before.live[paneKey],
      after.live[paneKey],
      before.layout.retainedAgentsByPaneKey[paneKey]?.entry,
      after.layout.retainedAgentsByPaneKey[paneKey]?.entry
    ]) {
      if (entry?.worktreeId) {
        result!.add(entry.worktreeId)
      }
    }
    for (const retained of [
      before.layout.retainedAgentsByPaneKey[paneKey],
      after.layout.retainedAgentsByPaneKey[paneKey]
    ]) {
      if (retained?.worktreeId) {
        result!.add(retained.worktreeId)
      }
    }
  }
  if (addChangedLayoutWorkspaces(result, before.layout, after.layout, tabOwners, includePane)) {
    addChangedOrchestrationWorkspaces(result, before.orchestration, after.orchestration)
    if (before.worktreesByRepo !== after.worktreesByRepo) {
      addChangedCatalogWorkspaces(result, before.worktreesByRepo, after.worktreesByRepo)
    }
    if (!sameInputs(after.owner, before.owner)) {
      addUnstampedChatWorkspaces(result, state)
    }
    forEachChangedKey(before.titles, after.titles, (tabId) => {
      const owner = tabOwners.get(tabId)
      if (owner) {
        result!.add(owner)
      }
    })
    forEachChangedKey(before.live, after.live, includePane)
    if (before.epoch !== after.epoch) {
      // A new epoch moves the clock: entries that kept their identity may still go stale.
      for (const paneKey in after.live) {
        const entry = after.live[paneKey]
        if (
          entry &&
          before.live[paneKey] === entry &&
          isAgentStatusFresh(entry, before.at, AGENT_STATUS_STALE_AFTER_MS) !==
            isAgentStatusFresh(entry, after.at, AGENT_STATUS_STALE_AFTER_MS)
        ) {
          includePane(paneKey)
        }
      }
    }
    forEachChangedKey(before.acknowledgements, after.acknowledgements, includePane)
  } else {
    result = null
  }
  let next = changes.get(before)
  if (!next) {
    next = new WeakMap()
    changes.set(before, next)
  }
  next.set(after, result)
  return result
}
