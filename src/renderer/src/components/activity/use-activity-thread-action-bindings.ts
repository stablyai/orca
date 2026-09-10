import { useCallback, useEffect, useMemo, useRef } from 'react'
import { clearCompletedActivity, isClearableActivityThread } from './activity-clear-completed'
import { createActivityThreadActions } from './activity-thread-actions'
import type { AgentPaneThread } from './activity-thread-types'

type ActivityThreadActionBindings = {
  markThreadRead: (thread: AgentPaneThread) => void
  markThreadUnread: (thread: AgentPaneThread) => void
  selectThread: (thread: AgentPaneThread) => void
  jumpToWorkspace: (thread: AgentPaneThread) => void
  markAllThreadsRead: () => void
  hasUnreadThreads: boolean
  hasCompletedThreads: boolean
  handleClearCompleted: () => void
}

/**
 * Bulk-action wiring shared by the sidebar Agents list and the full Activity
 * page, so their semantics can never drift apart:
 * - Mark all read acts on the badge-coherent set (`markAllReadThreads`), so the
 *   Agents-tab badge always reaches zero even when search/scope hides rows.
 * - Clear completed is destructive and acts only on `visibleThreads` — never on
 *   rows the user cannot currently see.
 */
export function useActivityThreadActionBindings({
  visibleThreads,
  markAllReadThreads,
  acknowledgeAgents,
  unacknowledgeAgents,
  setSelectedPaneKey
}: {
  visibleThreads: AgentPaneThread[]
  markAllReadThreads: AgentPaneThread[]
  acknowledgeAgents: (paneKeys: string[]) => void
  unacknowledgeAgents: (paneKeys: string[]) => void
  setSelectedPaneKey: (paneKey: string | null) => void
}): ActivityThreadActionBindings {
  // Why refs: rows are React.memo'd on these handlers; recreating them whenever a
  // thread array identity changes (every status ping) would re-render every mounted row.
  const visibleThreadsRef = useRef(visibleThreads)
  const markAllReadThreadsRef = useRef(markAllReadThreads)
  useEffect(() => {
    visibleThreadsRef.current = visibleThreads
    markAllReadThreadsRef.current = markAllReadThreads
  }, [visibleThreads, markAllReadThreads])

  const actions = useMemo(
    () =>
      createActivityThreadActions({
        getMarkAllReadThreads: () => markAllReadThreadsRef.current,
        acknowledgeAgents,
        unacknowledgeAgents,
        setSelectedPaneKey
      }),
    [acknowledgeAgents, unacknowledgeAgents, setSelectedPaneKey]
  )

  const hasUnreadThreads = useMemo(
    () => markAllReadThreads.some((t) => t.unread),
    [markAllReadThreads]
  )
  const hasCompletedThreads = useMemo(
    () => visibleThreads.some(isClearableActivityThread),
    [visibleThreads]
  )
  const handleClearCompleted = useCallback(() => {
    clearCompletedActivity(visibleThreadsRef.current)
  }, [])

  return { ...actions, hasUnreadThreads, hasCompletedThreads, handleClearCompleted }
}
