import { useCallback } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { getIndexedWorktreesById } from '@/store/worktree-repo-index'
import { isExplicitAgentStatusFresh } from '@/lib/pane-agent-evidence'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../../shared/agent-status/contracts/agent-status-freshness'
import { isAgentSubjectUnread } from '@/attention/agent-attention-acknowledgement'
import { readAgentRowTurnRecords } from '@/components/dashboard/dashboard-row-bucket'
import type { Worktree } from '../../../../shared/worktree/types'
import {
  getWorktreeHostIdentity,
  getWorktreeIdFromHostIdentity,
  type HostScopedWorktreeKey
} from '../../../../shared/worktree/host-qualified-identity'
import {
  selectLiveAgentStatusEntriesForWorktree,
  selectRetainedAgentEntriesForWorktree
} from './workspace-card/activity/worktree-agent-row-selectors'
import { projectSlotAgentLine } from './worktree-card-slot-agent-signals'
import { slotExceptionFor, type SlotSignal } from './worktree-card-slot-signal'
import {
  slotTargetsOfKind,
  workspaceUnreadTarget,
  type SlotTarget
} from './worktree-card-slot-targets'

/** Ids repeat across hosts, so a child resolves only to its own host's copy. */
function worktreeForIdentity(
  state: AppState,
  identity: HostScopedWorktreeKey
): Worktree | undefined {
  return getIndexedWorktreesById(
    state.worktreesByRepo,
    getWorktreeIdFromHostIdentity(identity)
  ).find((row) => getWorktreeHostIdentity(row) === identity)
}

/** Every agent line inside child workspaces, read from the same live and retained agent records the rows use. */
export function collectLineageSlotTargets(
  state: AppState,
  descendants: readonly HostScopedWorktreeKey[]
): SlotTarget[] {
  const now = Date.now()
  const lines: SlotTarget[] = []
  // Same acknowledgement records the agent rows read, so a child's unread matches its own card.
  const turnRecords = readAgentRowTurnRecords(state)
  for (const identity of descendants) {
    const worktreeId = getWorktreeIdFromHostIdentity(identity)
    for (const entry of selectLiveAgentStatusEntriesForWorktree(state, worktreeId)) {
      if (!isExplicitAgentStatusFresh(entry, now, AGENT_STATUS_STALE_AFTER_MS)) {
        continue
      }
      const { dotState, kind } = projectSlotAgentLine(
        { state: entry.state, entry },
        isAgentSubjectUnread(turnRecords, entry.paneKey)
      )
      lines.push({
        kind,
        at: entry.stateStartedAt > 0 ? entry.stateStartedAt : null,
        monitoring: dotState === 'monitoring',
        worktreeId,
        paneKey: entry.paneKey,
        retained: false,
        agentType: entry.agentType ?? null,
        entry
      })
    }
    for (const retained of selectRetainedAgentEntriesForWorktree(state, worktreeId)) {
      lines.push({
        kind: projectSlotAgentLine(
          { state: 'done', entry: retained.entry },
          isAgentSubjectUnread(turnRecords, retained.entry.paneKey)
        ).kind,
        at: retained.entry.stateStartedAt > 0 ? retained.entry.stateStartedAt : null,
        worktreeId,
        paneKey: retained.entry.paneKey,
        retained: true,
        agentType: retained.entry.agentType ?? null,
        entry: retained.entry
      })
    }
    const worktree = worktreeForIdentity(state, identity)
    // Any unread source counts: a tab or pane marker, or the user's own mark.
    if (worktree?.isUnread) {
      lines.push(workspaceUnreadTarget(worktreeId, worktree.lastActivityAt || null))
    }
  }
  return lines
}

/** Exceptions inside collapsed child workspaces. */
export function selectCollapsedLineageSlot(
  state: AppState,
  descendants: readonly HostScopedWorktreeKey[]
): SlotSignal | null {
  if (descendants.length === 0) {
    return null
  }
  return slotExceptionFor(collectLineageSlotTargets(state, descendants))
}

/** What one chip count stands for: the children counted under `kind`, and their agents of that kind. */
export function collectLineageChildTargetsOfKind(
  state: AppState,
  children: readonly HostScopedWorktreeKey[],
  kind: keyof LineageChildCounts
): SlotTarget[] {
  const targets: SlotTarget[] = []
  for (const child of children) {
    const lines = collectLineageSlotTargets(state, [child])
    if (slotExceptionFor(lines)?.kind === kind) {
      targets.push(...lines)
    }
  }
  return slotTargetsOfKind(targets, kind)
}

function splitIdentities(key: string): HostScopedWorktreeKey[] {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: `key` only ever joins HostScopedWorktreeKey values.
  return key ? (key.split('\n') as HostScopedWorktreeKey[]) : []
}

export function useCollapsedLineageSlot(
  descendants: readonly HostScopedWorktreeKey[]
): SlotSignal | null {
  const descendantKey = descendants.join('\n')
  const selector = useCallback(
    (state: AppState) => selectCollapsedLineageSlot(state, splitIdentities(descendantKey)),
    [descendantKey]
  )
  return useAppStore(useShallow(selector))
}

/** The most recent activity among child workspaces, so a parent never looks older than its children. */
export function selectLineageLatestAt(
  state: AppState,
  descendants: readonly HostScopedWorktreeKey[]
): number | null {
  let at = 0
  for (const identity of descendants) {
    const worktreeId = getWorktreeIdFromHostIdentity(identity)
    at = Math.max(at, worktreeForIdentity(state, identity)?.lastActivityAt ?? 0)
    for (const entry of selectLiveAgentStatusEntriesForWorktree(state, worktreeId)) {
      at = Math.max(at, entry.stateStartedAt)
    }
    for (const retained of selectRetainedAgentEntriesForWorktree(state, worktreeId)) {
      at = Math.max(at, retained.entry.stateStartedAt)
    }
  }
  return at > 0 ? at : null
}

export function useLineageLatestAt(descendants: readonly HostScopedWorktreeKey[]): number | null {
  const descendantKey = descendants.join('\n')
  return useAppStore(
    useCallback(
      (state: AppState) => selectLineageLatestAt(state, splitIdentities(descendantKey)),
      [descendantKey]
    )
  )
}

export type LineageChildCounts = { needs: number; failed: number; unread: number; working: number }

/** Direct children counted once each by their most urgent exception; quiet children aren't counted. */
export function selectLineageChildCounts(
  state: AppState,
  children: readonly HostScopedWorktreeKey[]
): LineageChildCounts {
  const counts: LineageChildCounts = { needs: 0, failed: 0, unread: 0, working: 0 }
  for (const child of children) {
    const signal = selectCollapsedLineageSlot(state, [child])
    if (signal && signal.kind in counts) {
      counts[signal.kind as keyof LineageChildCounts] += 1
    }
  }
  return counts
}

export function useLineageChildCounts(
  children: readonly HostScopedWorktreeKey[]
): LineageChildCounts {
  const childKey = children.join('\n')
  const selector = useCallback(
    (state: AppState) => selectLineageChildCounts(state, splitIdentities(childKey)),
    [childKey]
  )
  return useAppStore(useShallow(selector))
}
