import { CLOSE_TERMINAL_PANE_EVENT } from '@/constants/terminal'
import type { CloseTerminalPaneDetail } from '@/constants/terminal'
import { closeTerminalTab } from '@/components/terminal/terminal-tab-actions'
import { detectLanguage } from '@/lib/language-detect'
import { runSleepWorktree } from '@/components/sidebar/sleep-worktree-flow'
import { buildWorkspaceSessionPayload } from '@/lib/workspace-session'
import { persistWorkspaceSessionByHost } from '@/lib/workspace-session-host-persistence'
import { useAppStore } from '../../store'

export function registerMobileAndTerminalCloseIpcBridge(
  unsubs: (() => void)[],
  requestSleepingAgentWake: (worktreeId: string) => void
): void {
  unsubs.push(
    window.api.ui.onOpenFileFromMobile(
      ({ worktreeId, filePath, relativePath, runtimeEnvironmentId }) => {
        const store = useAppStore.getState()
        const basename = relativePath.split(/[\\/]/).pop() || relativePath
        store.setActiveWorktree(worktreeId)
        store.markWorktreeVisited(worktreeId)
        store.setActiveView('terminal')
        // Why: renderer owns tab creation so grouped order and markdown bridges share the desktop File Explorer's store path.
        store.openFile({
          filePath,
          relativePath,
          worktreeId,
          language: detectLanguage(basename),
          runtimeEnvironmentId,
          mode: 'edit'
        })
        store.setActiveTabType('editor')
        store.revealWorktreeInSidebar(worktreeId)
      }
    )
  )

  unsubs.push(
    window.api.ui.onOpenDiffFromMobile(
      ({ worktreeId, filePath, relativePath, staged, runtimeEnvironmentId }) => {
        const store = useAppStore.getState()
        const language = detectLanguage(relativePath)
        store.setActiveWorktree(worktreeId)
        store.markWorktreeVisited(worktreeId)
        store.setActiveView('terminal')
        // Why: mobile renders diffs from metadata; the editor-local Changes shortcut would send plain markdown back to mobile.
        store.openDiff(worktreeId, filePath, relativePath, language, staged, {
          runtimeEnvironmentId
        })
        store.setActiveTabType('editor')
        store.revealWorktreeInSidebar(worktreeId)
      }
    )
  )

  unsubs.push(
    window.api.ui.onCloseTerminal(({ tabId, paneRuntimeId }) => {
      if (paneRuntimeId != null) {
        // Why: route pane closes via the lifecycle hook for sibling promotion (falls through to closeTab on the last pane).
        const detail: CloseTerminalPaneDetail = { tabId, paneRuntimeId }
        window.dispatchEvent(new CustomEvent(CLOSE_TERMINAL_PANE_EVENT, { detail }))
      } else {
        // Why: the CLI/RPC caller is answered immediately, so it cannot wait on a modal.
        closeTerminalTab(tabId, { skipRunningProcessConfirm: true })
      }
    })
  )

  // Why: during an in-place renderer reload an older preload can linger; keep this listener additive at that seam.
  if (window.api.ui.onTerminalTabCloseRequest) {
    unsubs.push(
      window.api.ui.onTerminalTabCloseRequest(
        ({ requestId, tabId, localPtyTeardownOwnedExternally }) => {
          let responded = false
          const respond = (error?: string): void => {
            if (responded) {
              return
            }
            responded = true
            window.api.ui.respondTerminalTabClose({ requestId, ...(error ? { error } : {}) })
          }
          closeTerminalTab(tabId, {
            rejectPinned: true,
            ...(localPtyTeardownOwnedExternally ? { localPtyTeardownOwnedExternally: true } : {}),
            onCancel: () => respond('terminal_tab_pinned'),
            onClosed: () => {
              void (async () => {
                const state = useAppStore.getState()
                await persistWorkspaceSessionByHost(
                  window.api.session,
                  buildWorkspaceSessionPayload(state),
                  state
                )
                respond()
              })().catch((error: unknown) => {
                respond(error instanceof Error ? error.message : 'terminal_tab_close_failed')
              })
            }
          })
        }
      )
    )
  }

  unsubs.push(
    window.api.ui.onSleepWorktree(({ worktreeId }) => {
      void runSleepWorktree(worktreeId)
    })
  )

  unsubs.push(
    window.api.ui.onResumeSleepingAgents(({ worktreeId }) => {
      // Why: a phone opened this worktree; wake its slept agents without changing the desktop's worktree/tab/view.
      requestSleepingAgentWake(worktreeId)
    })
  )
}
