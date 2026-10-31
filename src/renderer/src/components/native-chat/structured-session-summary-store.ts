import { useCallback, useSyncExternalStore } from 'react'
import { create } from 'zustand'
import type { AgentSessionStatusSummary } from '../../../../shared/agent-session-wire'
import type { Tab } from '../../../../shared/tab-types'
import { structuredAgentSessionAgentStatus } from '../../../../shared/structured-agent-session-agent-status'
import { agentVerdictDisplayMark } from '../../../../shared/agent-main-agent-verdict'
import { getAgentRowPrimaryText } from '../../../../shared/agent-row-primary-text'
import { agentRowDotState } from '@/lib/agent-row-dot-state'

export const EMPTY_THREAD_IDS: ReadonlySet<string> = new Set()
export type ThreadRowSnapshot = {
  tab: Tab | undefined
  workspaceId: string
  title: string
  agent: AgentSessionStatusSummary['agent']
  state: ReturnType<typeof agentRowDotState>
  updatedAt: number
}

// Organization changes independently of live row facts; ordinary chats never enter this projection.
export const useStructuredSessionSummaries = create<{
  threadTabIds: ReadonlySet<string>
  byWorktree: ReadonlyMap<string, ReadonlySet<string>>
  orderedIds: readonly string[]
}>(() => ({ threadTabIds: EMPTY_THREAD_IDS, byWorktree: new Map(), orderedIds: [] }))
const rows = new Map<string, ThreadRowSnapshot>()
const rowListeners = new Map<string, Set<() => void>>()
const workspaceListeners = new Map<string, Set<() => void>>()

export function useThreadRow(tabId: string): ThreadRowSnapshot | undefined {
  const subscribe = useCallback(
    (listener: () => void) => {
      let listeners = rowListeners.get(tabId)
      if (!listeners) {
        listeners = new Set()
        rowListeners.set(tabId, listeners)
      }
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
        if (!listeners.size) {
          rowListeners.delete(tabId)
        }
      }
    },
    [tabId]
  )
  const snapshot = useCallback(() => rows.get(tabId), [tabId])
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}

export function useThreadMembership(worktreeId: string | null | undefined, enabled: boolean) {
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!enabled || !worktreeId) {
        return () => {}
      }
      const listeners = workspaceListeners.get(worktreeId) ?? new Set<() => void>()
      workspaceListeners.set(worktreeId, listeners)
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
        if (!listeners.size) {
          workspaceListeners.delete(worktreeId)
        }
      }
    },
    [worktreeId, enabled]
  )
  const snapshot = useCallback(
    () =>
      enabled && worktreeId
        ? (useStructuredSessionSummaries.getState().byWorktree.get(worktreeId) ?? EMPTY_THREAD_IDS)
        : EMPTY_THREAD_IDS,
    [worktreeId, enabled]
  )
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}

export function publishStructuredSessionSummaries(
  updates: readonly {
    tabId: string
    tab?: Tab
    summary: AgentSessionStatusSummary | null
    surface?: 'thread'
  }[]
): void {
  const previous = useStructuredSessionSummaries.getState()
  let membership: Set<string> | undefined
  let workspaces: Map<string, ReadonlySet<string>> | undefined
  let reorder = false
  const workspaceDrafts = new Map<string, Set<string>>()
  const changedWorkspaces = new Set<string>()
  const changed = new Set<string>()
  const editWorkspace = (workspaceId: string, id: string, add: boolean) => {
    changedWorkspaces.add(workspaceId)
    workspaces ??= new Map(previous.byWorktree)
    let ids = workspaceDrafts.get(workspaceId)
    if (!ids) {
      ids = new Set(previous.byWorktree.get(workspaceId) ?? EMPTY_THREAD_IDS)
      workspaceDrafts.set(workspaceId, ids)
    }
    if (add) {
      ids.add(id)
    } else {
      ids.delete(id)
    }
    if (ids.size) {
      workspaces.set(workspaceId, ids)
    } else {
      workspaces.delete(workspaceId)
    }
  }
  for (const { tabId, tab, summary, surface } of updates) {
    const old = rows.get(tabId)
    const thread = summary ? summary.surface === 'thread' : surface === 'thread'
    if (!thread && !old) {
      continue
    }
    if (thread) {
      const status =
        summary?.status == null
          ? null
          : structuredAgentSessionAgentStatus({
              ...summary,
              status: summary.status,
              childWork: summary.children ?? summary.backgroundTasks
            })
      const next: ThreadRowSnapshot = {
        tab:
          tab &&
          old?.tab &&
          tab.id === old.tab.id &&
          tab.entityId === old.tab.entityId &&
          tab.worktreeId === old.tab.worktreeId &&
          tab.executionHostId === old.tab.executionHostId
            ? old.tab
            : (tab ?? old?.tab),
        workspaceId: tab?.worktreeId ?? summary?.workspaceId ?? '',
        title:
          summary?.conversationName ||
          getAgentRowPrimaryText({ prompt: summary?.latestPrompt ?? '' }) ||
          tab?.label ||
          old?.tab?.label ||
          '',
        agent: summary?.agent ?? tab?.agentSessionAgent ?? old?.agent ?? 'claude',
        state: status
          ? (agentVerdictDisplayMark(status) ?? agentRowDotState(status.state, status.workingMode))
          : 'idle',
        updatedAt: summary?.updatedAt ?? tab?.createdAt ?? old?.updatedAt ?? 0
      }
      if (
        old &&
        Object.keys(next).every((key) => Object.is(Reflect.get(old, key), Reflect.get(next, key)))
      ) {
        continue
      }
      rows.set(tabId, next)
      if (!old || old.workspaceId !== next.workspaceId) {
        membership ??= new Set(previous.threadTabIds)
        membership.add(tabId)
        if (old) {
          editWorkspace(old.workspaceId, tabId, false)
        }
        editWorkspace(next.workspaceId, tabId, true)
      }
      reorder ||= !old || old.updatedAt !== next.updatedAt
    } else if (old) {
      rows.delete(tabId)
      membership ??= new Set(previous.threadTabIds)
      membership.delete(tabId)
      editWorkspace(old.workspaceId, tabId, false)
      reorder = true
    }
    changed.add(tabId)
  }
  if (membership || reorder) {
    const ids = membership ?? previous.threadTabIds
    useStructuredSessionSummaries.setState({
      ...(membership ? { threadTabIds: membership } : {}),
      ...(workspaces ? { byWorktree: workspaces } : {}),
      ...(reorder
        ? {
            orderedIds: [...ids].sort(
              (a, b) =>
                (rows.get(b)?.updatedAt ?? 0) - (rows.get(a)?.updatedAt ?? 0) || a.localeCompare(b)
            )
          }
        : {})
    })
  }
  for (const id of changedWorkspaces) {
    workspaceListeners.get(id)?.forEach((listener) => listener())
  }
  for (const id of changed) {
    rowListeners.get(id)?.forEach((listener) => listener())
  }
}

export function isThreadTab(
  enabled: boolean,
  tabId: string,
  threadTabIds: ReadonlySet<string>
): boolean {
  return enabled && threadTabIds.has(tabId)
}
