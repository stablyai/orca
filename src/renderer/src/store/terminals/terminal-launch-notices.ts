import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import type { TerminalSlice, TerminalStoreGet, TerminalStoreSet } from './terminal-state'

export function createTerminalLaunchNoticeActions(
  set: TerminalStoreSet,
  get: TerminalStoreGet
): Pick<TerminalSlice, 'attachLaunchNotices' | 'dismissLaunchNotice'> {
  return {
    attachLaunchNotices: ({ worktreeId, tabId, launchToken, notices }) => {
      if (notices.length === 0) {
        return
      }
      set((state) => {
        const tabs = state.tabsByWorktree[worktreeId]
        if (!tabs) {
          return {}
        }
        return {
          tabsByWorktree: {
            ...state.tabsByWorktree,
            [worktreeId]: tabs.map((tab) =>
              tab.id === tabId ? { ...tab, launchNotices: { launchToken, notices } } : tab
            )
          }
        }
      })
    },
    dismissLaunchNotice: ({ worktreeId, tabId, launchToken, code }) => {
      // Clear optimistically while the host persists the dismissal.
      const runtimeEnvironmentId = getRuntimeEnvironmentIdForWorktree(get(), worktreeId)
      if (runtimeEnvironmentId) {
        void import('@/runtime/web-runtime-session')
          .then(({ dismissWebRuntimeLaunchNotice }) =>
            dismissWebRuntimeLaunchNotice({ worktreeId, tabId, launchToken, code })
          )
          .catch(() => {})
      } else {
        void window.api.pty
          .dismissLaunchNotice({ worktreeId, tabId, launchToken, code })
          .catch(() => {})
      }
      set((state) => {
        const tabs = state.tabsByWorktree[worktreeId]
        if (!tabs) {
          return {}
        }
        return {
          tabsByWorktree: {
            ...state.tabsByWorktree,
            [worktreeId]: tabs.map((tab) => {
              if (tab.id !== tabId || tab.launchNotices?.launchToken !== launchToken) {
                return tab
              }
              const notices = tab.launchNotices.notices.filter((notice) => notice.code !== code)
              const { launchNotices: _launchNotices, ...rest } = tab
              return notices.length > 0
                ? { ...rest, launchNotices: { launchToken, notices } }
                : rest
            })
          }
        }
      })
    }
  }
}
