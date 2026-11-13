import { requestSessionTabScroll } from '@/lib/workspace/tabs/session-tab-scroll-event'
import { resolveWindowTabIdForHostTab } from './host-session-tab-target'

export function registerSessionTabScrollIpcBridge(unsubs: (() => void)[]): void {
  unsubs.push(
    window.api.ui.onScrollSessionTab(({ requestId, worktreeId, tabId, leafId, deltaY }) => {
      let scrolled = false
      try {
        scrolled = requestSessionTabScroll(
          resolveWindowTabIdForHostTab(worktreeId, tabId),
          leafId,
          deltaY
        )
      } catch (error) {
        console.error('Failed to scroll session tab:', error)
      } finally {
        // Why: main holds the caller's RPC open until this reply, so a throw must still answer.
        window.api.ui.replySessionTabScroll({ requestId, scrolled })
      }
    })
  )
}
