import {
  SET_TERMINAL_PANE_TITLE_EVENT,
  type SetTerminalPaneTitleDetail
} from '@/constants/terminal'
import { applyClosedTerminalLeafNotice } from '@/components/terminal-pane/closed-terminal-leaf-notice'
import { collectLeafIdsInOrder } from '@/components/terminal-pane/terminal-layout-leaf-ids'
import type { TerminalLayoutSnapshot } from '../../../../shared/terminal-tab-types'
import { isTerminalLeafId } from '../../../../shared/stable-pane-id'
import { closeTerminalTab } from '@/components/terminal/terminal-tab-actions'
import { detectLanguage } from '@/lib/language-detect'
import { runSleepWorktree } from '@/components/sidebar/sleep-worktree-flow'
import { buildWorkspaceSessionPayload } from '@/lib/workspace-session'
import { persistWorkspaceSessionByHost } from '@/lib/workspace-session-host-persistence'
import { useAppStore } from '../../store'
import type { AppState } from '../../store/types'
import type { EditorTabSelection } from '../../store/slices/editor/types/open-file'
import {
  navigationTargetsHost,
  type RuntimeNavigationTarget
} from '../../../../shared/runtime-navigation'

// Why: a caller that names a non-host target (CLI without --focus) must not change anything on screen;
// the tab is selected only inside a worktree the user is not viewing, without counting as a visit.
// No target (phones, older CLIs) keeps the original switch, which the phone's "Open in session" relies on.
function openRuntimeEditorTab(
  worktreeId: string,
  navigation: RuntimeNavigationTarget | undefined,
  open: (store: AppState, selection: EditorTabSelection) => void
): void {
  const store = useAppStore.getState()
  if (navigation !== undefined && !navigationTargetsHost(navigation)) {
    open(store, worktreeId === store.activeWorktreeId ? 'none' : 'background')
    return
  }
  store.setActiveWorktree(worktreeId)
  store.markWorktreeVisited(worktreeId)
  store.setActiveView('terminal')
  open(store, 'focus')
  store.setActiveTabType('editor', worktreeId)
  store.revealWorktreeInSidebar(worktreeId)
}

export function registerMobileAndTerminalCloseIpcBridge(
  unsubs: (() => void)[],
  requestSleepingAgentWake: (worktreeId: string) => void
): void {
  unsubs.push(
    window.api.ui.onOpenFileFromMobile(
      ({ worktreeId, filePath, relativePath, runtimeEnvironmentId, navigation }) => {
        const basename = relativePath.split(/[\\/]/).pop() || relativePath
        openRuntimeEditorTab(worktreeId, navigation, (store, selection) =>
          // Why: renderer owns tab creation so grouped order and markdown bridges share the desktop File Explorer's store path.
          store.openFile(
            {
              filePath,
              relativePath,
              worktreeId,
              language: detectLanguage(basename),
              runtimeEnvironmentId,
              mode: 'edit'
            },
            { selection }
          )
        )
      }
    )
  )

  unsubs.push(
    window.api.ui.onOpenDiffFromMobile(
      ({ worktreeId, filePath, relativePath, staged, runtimeEnvironmentId, navigation }) => {
        openRuntimeEditorTab(worktreeId, navigation, (store, selection) =>
          // Why: mobile renders diffs from metadata; the editor-local Changes shortcut would send plain markdown back to mobile.
          store.openDiff(worktreeId, filePath, relativePath, detectLanguage(relativePath), staged, {
            runtimeEnvironmentId,
            selection
          })
        )
      }
    )
  )

  unsubs.push(
    window.api.ui.onCloseTerminal((target) => {
      if (target.kind === 'pane') {
        applyClosedTerminalLeafNotice(target.tabId, target.leafId)
      } else {
        // Why: the CLI/RPC caller is answered immediately, so it cannot wait on a modal.
        closeTerminalTab(target.tabId, { skipRunningProcessConfirm: true })
      }
    })
  )

  // Why: during an in-place renderer reload an older preload can linger; keep this listener additive at that seam.
  if (window.api.ui.onSetPaneTitle) {
    unsubs.push(
      window.api.ui.onSetPaneTitle(({ tabId, leafId, title }) => {
        const store = useAppStore.getState()
        const layout = store.terminalLayoutsByTabId[tabId]
        if (
          !layout ||
          !isTerminalLeafId(leafId) ||
          !collectLeafIdsInOrder(layout.root).includes(leafId)
        ) {
          return
        }
        // Parked panes have no event listener; their next mount reads this same layout.
        const titlesByLeafId = { ...layout.titlesByLeafId }
        if (title) {
          titlesByLeafId[leafId] = title
        } else {
          delete titlesByLeafId[leafId]
        }
        const nextLayout: TerminalLayoutSnapshot = { ...layout, titlesByLeafId }
        if (Object.keys(titlesByLeafId).length === 0) {
          delete nextLayout.titlesByLeafId
        }
        store.setTabLayout(tabId, nextLayout)
        const detail: SetTerminalPaneTitleDetail = { tabId, leafId, title }
        window.dispatchEvent(new CustomEvent(SET_TERMINAL_PANE_TITLE_EVENT, { detail }))
      })
    )
  }

  // Why: during an in-place renderer reload an older preload can linger; keep this listener additive at that seam.
  if (window.api.ui.onTerminalTabCloseRequest) {
    unsubs.push(
      window.api.ui.onTerminalTabCloseRequest(
        ({ requestId, tabId, localPtyTeardownOwnedExternally, force }) => {
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
            ...(force ? { force: true } : {}),
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
