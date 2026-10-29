import { useCallback, useEffect, useMemo, useRef } from 'react'
import { clearCompletedActivity, isClearableActivityThread } from './activity-clear-completed'
import { createActivityThreadActions } from './activity-thread-actions'
import type { AgentPaneThread } from './activity-thread-types'

type ActivityThreadActionBindings = {
  markThreadRead: (thread: AgentPaneThread) => void
  markThreadUnread: (thread: AgentPaneThread) => void
  markThreadsRead: (threads: readonly AgentPaneThread[]) => void
  markThreadsUnread: (threads: readonly AgentPaneThread[]) => void
  selectThread: (thread: AgentPaneThread) => void
  jumpToWorkspace: (thread: AgentPaneThread) => void
  markAllThreadsRead: () => void
  hasUnreadThreads: boolean
  hasCompletedThreads: boolean
  handleClearCompleted: () => void
}

/** Share bulk semantics: Mark all read clears the badge-coherent set even when filtered; destructive Clear completed touches only visible rows. */
export function useActivityThreadActionBindings({
  visibleThreads,
  markAllReadThreads,
  acknowledgeAgents,
  unacknowledgeAgents,
  setSelectedPaneKey
}: {
  visibleThreads: AgentPaneThread[]
  markAllReadThreads: AgentPaneThread[]
  acknowledgeAgents: (paneKeys: string[], reads?: undefined, intent?: 'explicit') => void
  unacknowledgeAgents: (paneKeys: string[]) => void
  setSelectedPaneKey: (paneKey: string | null) => void
}): ActivityThreadActionBindings {
  // Keep row handlers stable across status pings; refs supply current thread sets without invalidating every memoized row.
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
