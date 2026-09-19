import { useEffect } from 'react'
import { useAppStore } from '@/store'
import { createCompletedConversationsSelector } from '@/lib/completed-agent-conversations'
import { activateActivityThreadTarget } from '@/components/activity/activity-thread-actions'

export function useCompletedConversationsDockMenu(): void {
  useEffect(() => {
    if (
      !navigator.userAgent.includes('Mac') ||
      window.__ORCA_WEB_CLIENT__ ||
      !window.api?.app?.setDockCompletedConversations ||
      !window.api?.app?.onOpenDockCompletedConversation
    ) {
      return
    }
    const select = createCompletedConversationsSelector()
    let previous: ReturnType<typeof select>['entries'] | null = null
    let disposed = false
    let scheduled = false
    const publish = (): void => {
      scheduled = false
      if (disposed) {
        return
      }
      const { entries } = select(useAppStore.getState())
      if (previous === entries) {
        return
      }
      previous = entries
      void window.api.app.setDockCompletedConversations(entries).catch(() => {
        previous = null
      })
    }
    const unsubscribe = useAppStore.subscribe(() => {
      if (scheduled) {
        return
      }
      scheduled = true
      queueMicrotask(publish)
    })
    const stopOpening = window.api.app.onOpenDockCompletedConversation((id) => {
      const thread = select(useAppStore.getState()).threads.get(id)
      if (!thread) {
        return
      }
      if (!activateActivityThreadTarget(thread, { providesInitialSurface: true })) {
        const state = useAppStore.getState()
        state.setSelectedActivityPaneKey(thread.paneKey)
        state.openActivityPage()
      }
    })
    publish()
    return () => {
      disposed = true
      unsubscribe()
      stopOpening()
      void window.api.app.setDockCompletedConversations([]).catch(() => {})
    }
  }, [])
}
