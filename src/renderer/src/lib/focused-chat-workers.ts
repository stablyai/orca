import { useMemo } from 'react'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import {
  structuredAgentSessionOwnerForTab,
  structuredAgentSessionTargetForHost
} from '@/runtime/native-chat/session-ownership/structured-agent-session-owner'
import type { Tab } from '../../../shared/workspace-layout/tab-groups/tab-types'
import type { OrchestrationSessionWorker } from '../../../shared/orchestration-session-workers'
import type { RuntimeClientTarget } from '../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { isStructuredTab } from '../../../shared/agent-session/view/structured-agent-session-tab'
import { useOrchestrationSessionsWorkers } from './orchestration-session-workers'

const LOCAL: RuntimeClientTarget = { kind: 'local' }
const NO_WORKERS: readonly OrchestrationSessionWorker[] = []

/** The tab the workspace's focused tab group shows. */
export function selectFocusedTab(state: AppState, worktreeId: string | null): Tab | null {
  if (!worktreeId) {
    return null
  }
  const groups = state.groupsByWorktree[worktreeId]
  const groupId = state.activeGroupIdByWorktree[worktreeId] ?? groups?.[0]?.id
  const tabId = groups?.find((group) => group.id === groupId)?.activeTabId
  return (tabId && state.unifiedTabsByWorktree[worktreeId]?.find((t) => t.id === tabId)) || null
}

/** The native chat in the workspace's focused tab group, if that group shows one. */
export function selectFocusedChatTab(state: AppState, worktreeId: string | null): Tab | null {
  const tab = selectFocusedTab(state, worktreeId)
  return tab && isStructuredTab(tab) ? tab : null
}

export type FocusedChatWorkers = {
  tab: Tab | null
  target: RuntimeClientTarget
  workers: readonly OrchestrationSessionWorker[]
}

/** The focused chat's workers, read through the shared per-chat feed. */
export function useFocusedChatWorkers(visible: boolean): FocusedChatWorkers {
  const tab = useAppStore((state) => selectFocusedChatTab(state, state.activeWorktreeId))
  const owner = useAppStore((state) => (tab ? structuredAgentSessionOwnerForTab(state, tab) : null))
  const target = useMemo(() => structuredAgentSessionTargetForHost(owner) ?? LOCAL, [owner])
  const sessionId = tab?.entityId ?? null
  const sessionIds = useMemo(() => (sessionId ? [sessionId] : []), [sessionId])
  const bySession = useOrchestrationSessionsWorkers(target, sessionIds, { visible })
  const workers = (sessionId ? bySession.get(sessionId) : undefined) ?? NO_WORKERS
  return { tab, target, workers }
}
