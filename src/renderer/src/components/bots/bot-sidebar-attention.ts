// Which of a bot list's watched workspaces show attention. A store write re-reads only the workspaces it
// can change (the agent projection's workspace journal and keyed tab records), so a write elsewhere reads none.
import type { AppState } from '@/store/types'
import type { AgentStatusProjection } from '@/store/slices/agent-status/projection/agent-status-projection'
import { getTabIdToWorktreeId } from '@/lib/workspace/tabs/tab-worktree-index'
import { selectLiveAgentStatusEntriesForWorktree } from '@/components/sidebar/workspace-card/activity/worktree-agent-row-selectors'
import {
  selectWorktreeActivityStatus,
  selectWorktreeTitleActivityStatus
} from '@/components/sidebar/workspace-card/activity/use-worktree-activity-status'
import { forEachChangedKey } from '@/components/sidebar/workspace-card/slots/worktree-card-slot-layout-invalidation'
import type { WorktreeStatus } from '../../../../shared/worktree/row-display/worktree-status-rollup'

/** Title statuses that positively say an agent works or asks; an idle live shell reads `active`. */
const TITLE_WORK: ReadonlySet<WorktreeStatus> = new Set(['working', 'monitoring', 'permission'])

/** Card statuses that say nothing is going on in a workspace. */
const IDLE_STATUSES: ReadonlySet<WorktreeStatus> = new Set([
  'inactive',
  'done',
  'failed',
  'interrupted'
])

const NO_IDS: readonly string[] = []

/** Any sign a workspace is not idle: its card's status (titles and permission prompts included) or any
 *  agent pane not done, read per pane so a failed pane can't mask a working one. */
export function workspaceHasAttention(state: AppState, id: string): boolean {
  return (
    !IDLE_STATUSES.has(selectWorktreeActivityStatus(state, id)) ||
    // A working or permission title counts even where the card's dot shows a failed hook.
    TITLE_WORK.has(selectWorktreeTitleActivityStatus(state, id)) ||
    selectLiveAgentStatusEntriesForWorktree(state, id).some((entry) => entry.state !== 'done')
  )
}

// What those selectors read besides the agent projection, by how a change names its workspaces.
const BY_WORKSPACE = ['tabsByWorktree', 'browserTabsByWorktree', 'unifiedTabsByWorktree'] as const
const BY_TAB = ['ptyIdsByTabId', 'terminalLayoutsByTabId', 'runtimePaneTitlesByTabId'] as const
/** Sleep answers, stopped hosts and workspace owners: a change re-reads every workspace. */
const UNKEYED = [
  'structuredChatSleptAtByPaneKey',
  'wslHostStatuses',
  'repos',
  'folderWorkspaces',
  'projectGroups'
] as const
const SOURCES = [...BY_WORKSPACE, ...BY_TAB, ...UNKEYED] as const

type Seen = Pick<AppState, (typeof SOURCES)[number]> & {
  projection: AgentStatusProjection
  cursor: number
}

function see(state: AppState): Seen {
  const projection = state.agentStatusByPaneKey.projection
  const seen: Record<string, unknown> = { projection, cursor: projection.worktreeChanges.cursor() }
  for (const key of SOURCES) {
    seen[key] = state[key]
  }
  return seen as Seen
}

function unchangedSince(seen: Seen, state: AppState): boolean {
  const projection = state.agentStatusByPaneKey.projection
  return (
    seen.projection === projection &&
    seen.cursor === projection.worktreeChanges.cursor() &&
    SOURCES.every((key) => seen[key] === state[key])
  )
}

/** Workspaces whose attention the step between two reads may have changed; null when any may have. */
function changedBetween(before: Seen, after: Seen): Set<string> | null {
  if (before.projection !== after.projection || UNKEYED.some((key) => before[key] !== after[key])) {
    return null
  }
  const agents = after.projection.worktreeChanges.since(before.cursor)
  if (!agents) {
    return null
  }
  const changed = new Set(agents)
  const add = (id: string): void => {
    changed.add(id)
  }
  for (const key of BY_WORKSPACE) {
    forEachChangedKey(before[key], after[key], add)
  }
  // A tab that moved changed both workspaces' tab lists above; its own records follow its new owner.
  if (BY_TAB.some((key) => before[key] !== after[key])) {
    const owners = getTabIdToWorktreeId(after.tabsByWorktree)
    for (const key of BY_TAB) {
      forEachChangedKey(before[key], after[key], (tabId) => {
        const id = owners.get(tabId)
        if (id !== undefined) {
          changed.add(id)
        }
      })
    }
  }
  return changed
}

/** A store selector for the watched workspaces showing attention, in watched order, the same array while
 *  the answer holds. One per list: a new watched list reads only the ids it adds. */
export function createWatchedAttentionReader(): (
  state: AppState,
  watchedIds: readonly string[]
) => readonly string[] {
  let seen: Seen | null = null
  let watchedList: readonly string[] = NO_IDS
  let watched = new Set<string>()
  // The watched ids with attention, correct for the state last seen.
  const attention = new Set<string>()
  let result = NO_IDS
  return (state, watchedIds) => {
    if (watchedIds.length === 0) {
      // Nothing watched reads nothing; the next list is read whole.
      seen = null
      watchedList = watchedIds
      if (watched.size > 0) {
        watched = new Set()
        attention.clear()
      }
      result = NO_IDS
      return result
    }
    const stateMoved = !seen || !unchangedSince(seen, state)
    if (!stateMoved && watchedIds === watchedList) {
      return result
    }
    let moved = false
    const read = (id: string): void => {
      if (workspaceHasAttention(state, id) !== attention.has(id)) {
        moved = true
        if (attention.has(id)) {
          attention.delete(id)
        } else {
          attention.add(id)
        }
      }
    }
    if (stateMoved) {
      const now = see(state)
      const changed = seen ? changedBetween(seen, now) : null
      if (changed) {
        for (const id of changed) {
          if (watched.has(id)) {
            read(id)
          }
        }
      } else {
        watched.forEach(read)
      }
      seen = now
    }
    if (watchedIds !== watchedList) {
      const next = new Set(watchedIds)
      for (const id of attention) {
        if (!next.has(id)) {
          attention.delete(id)
        }
      }
      for (const id of next) {
        if (!watched.has(id)) {
          read(id)
        }
      }
      // Same members in another order still reorders the answer.
      moved = true
      watched = next
      watchedList = watchedIds
    }
    if (moved) {
      result = attention.size === 0 ? NO_IDS : watchedIds.filter((id) => attention.has(id))
    }
    return result
  }
}
