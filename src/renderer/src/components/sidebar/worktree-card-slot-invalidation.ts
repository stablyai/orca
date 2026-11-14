import type { AppState } from '@/store/types'
import { getStructuredAgentSessionTabsByPaneKey } from '@/components/native-chat/session/status/structured-agent-session-tabs'
import { parsePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import {
  getLiveTabIdToWorktreeId,
  getTabIdToWorktreeId
} from './workspace-card/activity/worktree-agent-row-selectors'
import { liveEntryWorktreeId } from './workspace-card/activity/worktree-agent-live-index-patch'
import { createFreshnessDeadlines, forEachPaneDisplayer } from './worktree-card-slot-pane-index'
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
  worktrees: AppState['worktreesByRepo']
  /** Workspace selection, settings and catalog: only consulted for chats with no stamped host. */
  owner: readonly unknown[]
  live: AppState['agentStatusByPaneKey']
  acknowledgements: AppState['acknowledgedAgentsByPaneKey']
  titles: AppState['runtimePaneTitlesByTabId']
  epoch: number
  /** The clock freshness is judged at; re-sampled only when the epoch moves. */
  at: number
  /** The snapshot this one replaced, while the journal still reaches back to it. */
  previous: SlotSnapshot | undefined
  /** Workspaces whose slots may differ from `previous`'s; null when any slot may. */
  changedFromPrevious: Set<string> | null
}

/**
 * Snapshots form a short journal: each one's changes are computed once, when it replaces the
 * previous one, and every lineage tree combines the steps since the snapshot it last saw. A tree
 * that falls further behind than the journal re-checks all of its slots.
 */
const JOURNAL_LENGTH = 16
let current: SlotSnapshot | undefined
const freshnessDeadlines = createFreshnessDeadlines()

export function slotSnapshot(state: AppState): SlotSnapshot {
  const inputs = worktreeAgentProjectionInputs(state)
  if (!current || !sameInputs(inputs, current.inputs)) {
    const previous = current
    const next: SlotSnapshot = {
      inputs,
      layout: {
        tabsByWorktree: state.tabsByWorktree,
        unifiedTabsByWorktree: state.unifiedTabsByWorktree,
        migrationUnsupportedByPtyId: state.migrationUnsupportedByPtyId,
        ptyIdsByTabId: state.ptyIdsByTabId,
        terminalLayoutsByTabId: state.terminalLayoutsByTabId,
        runtimeAgentOrchestrationByPaneKey: state.runtimeAgentOrchestrationByPaneKey,
        paneForegroundAgentByPaneKey: state.paneForegroundAgentByPaneKey
      },
      orchestration: selectWorktreeAgentOrchestrationIndex(state),
      worktrees: selectWorktreesByRepo(state),
      owner: structuredAgentSessionOwnerInputs(state),
      live: state.agentStatusByPaneKey,
      acknowledgements: state.acknowledgedAgentsByPaneKey,
      titles: state.runtimePaneTitlesByTabId,
      epoch: state.agentStatusEpoch,
      at: previous?.epoch === state.agentStatusEpoch ? previous.at : Date.now(),
      previous,
      changedFromPrevious: null
    }
    if (previous) {
      next.changedFromPrevious = changedBetween(state, previous, next)
    } else {
      freshnessDeadlines.clear()
      for (const paneKey in next.live) {
        freshnessDeadlines.set(paneKey, next.live[paneKey], next.at)
      }
    }
    trimJournal(next)
    current = next
  }
  return current
}

function trimJournal(latest: SlotSnapshot): void {
  let cursor: SlotSnapshot | undefined = latest
  for (let depth = 0; cursor && depth < JOURNAL_LENGTH; depth += 1) {
    cursor = cursor.previous
  }
  if (cursor) {
    cursor.previous = undefined
  }
}

/** Workspaces whose slots may differ between two snapshots; null when any slot may. */
export function changedSlotWorkspaces(
  before: SlotSnapshot,
  after: SlotSnapshot
): Set<string> | null {
  const result = new Set<string>()
  for (let cursor = after; cursor !== before;) {
    if (!cursor.previous || !cursor.changedFromPrevious) {
      return null
    }
    for (const id of cursor.changedFromPrevious) {
      result.add(id)
    }
    cursor = cursor.previous
  }
  return result
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
 * One journal step. Pane-keyed records (status, acknowledgement, retention, foreground agent,
 * freshness) reach the workspaces the projection recorded as displaying the pane, plus the
 * owner the live bucket assigns it, so ownership is never re-derived with separate rules.
 */
function changedBetween(
  state: AppState,
  before: SlotSnapshot,
  after: SlotSnapshot
): Set<string> | null {
  const result = new Set<string>()
  const add = (worktreeId: string): void => {
    result.add(worktreeId)
  }
  const tabOwners = getTabIdToWorktreeId(state.tabsByWorktree)
  const liveTabOwners = getLiveTabIdToWorktreeId(state.tabsByWorktree, state.unifiedTabsByWorktree)
  const represented = getStructuredAgentSessionTabsByPaneKey(state.unifiedTabsByWorktree)
  const includePane = (paneKey: string): void => {
    forEachPaneDisplayer(paneKey, add)
    // A pane no slot has displayed yet lands where the live bucket or its tab puts it.
    const parsed = parsePaneKey(paneKey)
    const tabOwner = parsed && liveTabOwners.get(parsed.tabId)
    if (tabOwner) {
      result.add(tabOwner)
    }
    const chat = represented.get(paneKey)
    if (chat) {
      result.add(chat.worktreeId)
    }
    for (const entry of [before.live[paneKey], after.live[paneKey]]) {
      const owner = entry && liveEntryWorktreeId(paneKey, entry, liveTabOwners, represented)
      if (owner) {
        result.add(owner)
      }
    }
  }

  // Freshness bookkeeping follows every step, even one that re-checks every slot.
  forEachChangedKey(before.live, after.live, (paneKey) => {
    freshnessDeadlines.set(paneKey, after.live[paneKey], after.at)
  })
  const expired: string[] = []
  if (before.at !== after.at) {
    // Only entries whose stale deadline fell between the two clock samples flip.
    freshnessDeadlines.expire(after.at, (paneKey) => expired.push(paneKey))
  }

  if (!addChangedLayoutWorkspaces(result, before.layout, after.layout, tabOwners, includePane)) {
    return null
  }
  addChangedOrchestrationWorkspaces(result, before.orchestration, after.orchestration)
  if (before.worktrees !== after.worktrees) {
    addChangedCatalogWorkspaces(result, before.worktrees, after.worktrees)
  }
  if (!sameInputs(after.owner, before.owner)) {
    addUnstampedChatWorkspaces(result, state)
  }
  forEachChangedKey(before.titles, after.titles, (tabId) => {
    const owner = tabOwners.get(tabId)
    if (owner) {
      result.add(owner)
    }
  })
  forEachChangedKey(before.live, after.live, includePane)
  expired.forEach(includePane)
  forEachChangedKey(before.acknowledgements, after.acknowledgements, includePane)
  return result
}
