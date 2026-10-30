import { createRuntimeFilePositionQueue } from './runtime-file-position'
import { applyClosedTerminalLeafNotice } from '@/components/terminal-pane/closed-terminal-leaf-notice'
import { closeTerminalTab } from '@/components/terminal/terminal-tab-actions'
import { detectLanguage } from '@/lib/language-detect'
import { followWorkspaceSleep } from '@/components/sidebar/workspace-sleep-follower'
import { createProjectMovePauseFollower } from '@/components/sidebar/project-move-pause-follower'
import { buildWorkspaceSessionPayload } from '@/lib/workspace-session'
import { persistWorkspaceSessionByHost } from '@/lib/workspace-session-host-persistence'
import { revealWorkspaceSurface } from '@/lib/workspace-surface-reveal'
import { selectFloatingWorkspacePanelVisible } from '@/store/floating-workspace-panel-selector'
import { isFloatingWorkspaceId } from '../../../../shared/floating-workspace-worktree'
import { useAppStore } from '../../store'
import { afterLayoutFrame, layoutFramesFlowing } from '@/runtime/layout-frame-position'
import { framesDrawWorkspace } from '@/runtime/workspace-layout-frame-drawn-workspaces'
import type { RuntimeEditorTabReveal } from '../../../../shared/runtime-file-contracts'
import type { AppState } from '../../store/types'
import type { EditorTabSelection } from '../../store/slices/editor/types/open-file'
import {
  navigationTargetsHost,
  type RuntimeNavigationTarget
} from '../../../../shared/runtime-navigation'

// Explicit non-host targets stay off-screen without visit accounting; absent targets preserve older CLI/phone Open in session behavior.
function openRuntimeEditorTab(
  worktreeId: string,
  navigation: RuntimeNavigationTarget | undefined,
  open: (store: AppState, selection: EditorTabSelection) => void
): void {
  const store = useAppStore.getState()
  if (navigation !== undefined && !navigationTargetsHost(navigation)) {
    const isViewed =
      worktreeId === store.activeWorktreeId ||
      (isFloatingWorkspaceId(worktreeId) && selectFloatingWorkspacePanelVisible(store))
    open(store, isViewed ? 'none' : 'background')
    return
  }
  revealWorkspaceSurface(store, worktreeId)
  open(store, 'focus')
  store.setActiveTabType('editor', worktreeId)
}

/** Show only if the window currently draws main’s editor tab. */
function showMainEditorTab(
  { worktreeId, tabId, navigation, position }: RuntimeEditorTabReveal,
  positionFile: ReturnType<typeof createRuntimeFilePositionQueue>
): boolean {
  const tab = useAppStore
    .getState()
    .unifiedTabsByWorktree[worktreeId]?.find((entry) => entry.id === tabId)
  if (!tab) {
    return false
  }
  openRuntimeEditorTab(worktreeId, navigation, (store, selection) => {
    if (selection !== 'none') {
      store.activateTab(tabId, selection === 'background' ? { recordFocus: false } : {})
    }
    positionFile(tab.entityId, position, selection === 'focus')
  })
  return true
}

/** After first-visit group/frame hydration, show the tab unless the user left or frames stopped. */
function showOnceWorkspaceDraws({ worktreeId }: RuntimeEditorTabReveal, show: () => void): void {
  const unsubscribe = useAppStore.subscribe((state) => {
    const viewed = isFloatingWorkspaceId(worktreeId)
      ? selectFloatingWorkspacePanelVisible(state)
      : state.activeWorktreeId === worktreeId
    if (!viewed || !layoutFramesFlowing()) {
      unsubscribe()
    } else if (framesDrawWorkspace(state)(worktreeId)) {
      unsubscribe()
      // Frame sync subscribes first, so its queued flush precedes this task; before sync starts, defer display until another visit.
      queueMicrotask(show)
    }
  })
}

export function registerMobileAndTerminalCloseIpcBridge(
  unsubs: (() => void)[],
  requestSleepingAgentWake: (worktreeId: string) => void
): void {
  const positionFile = createRuntimeFilePositionQueue(unsubs)
  unsubs.push(
    window.api.ui.onOpenFileFromMobile(
      ({ worktreeId, filePath, relativePath, runtimeEnvironmentId, navigation, position }) => {
        const basename = relativePath.split(/[\\/]/).pop() || relativePath
        openRuntimeEditorTab(worktreeId, navigation, (store, selection) => {
          // Use File Explorer’s creation path so grouped ordering and markdown bridges stay consistent.
          const fileId = store.openFile(
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
          positionFile(fileId, position, selection === 'focus')
        })
      }
    )
  )

  // Show main-owned tabs after their frame draws; channel stays optional for older preloads surviving reload.
  if (window.api.ui.onRevealEditorTabFromRuntime) {
    unsubs.push(
      window.api.ui.onRevealEditorTabFromRuntime((reveal) =>
        // No stream coming ('none' or ended): runs now, and an undrawn tab is left unshown.
        afterLayoutFrame(reveal.frameSeq, () => {
          if (showMainEditorTab(reveal, positionFile)) {
            return
          }
          const store = useAppStore.getState()
          const { worktreeId, navigation } = reveal
          // An undrawn workspace draws main's tabs on its first visit; a background open waits for it.
          if (
            framesDrawWorkspace(store)(worktreeId) ||
            !layoutFramesFlowing() ||
            (navigation !== undefined && !navigationTargetsHost(navigation))
          ) {
            return
          }
          revealWorkspaceSurface(store, worktreeId)
          showOnceWorkspaceDraws(reveal, () => showMainEditorTab(reveal, positionFile))
        })
      )
    )
  }

  unsubs.push(
    window.api.ui.onOpenDiffFromMobile(
      ({
        worktreeId,
        filePath,
        relativePath,
        staged,
        runtimeEnvironmentId,
        navigation,
        oldPath
      }) => {
        openRuntimeEditorTab(worktreeId, navigation, (store, selection) =>
          // Why: mobile renders diffs from metadata; the editor-local Changes shortcut would send plain markdown back to mobile.
          store.openDiff(worktreeId, filePath, relativePath, detectLanguage(relativePath), staged, {
            runtimeEnvironmentId,
            selection,
            ...(oldPath ? { oldPath } : {})
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

  // A sleep main runs, from this window or a phone: the window hides the workspace and its panes.
  if (window.api.ui.onProjectMovePause && window.api.ui.respondProjectMovePause) {
    const movePause = createProjectMovePauseFollower(window.api.ui.respondProjectMovePause)
    unsubs.push(
      window.api.ui.onProjectMovePause((request) => {
        void movePause.request(request).catch((error: unknown) => {
          console.warn('[project-move-pause] renderer reply failed', error)
        })
      })
    )
    unsubs.push(window.api.ui.onWorkspaceSleep(movePause.follow))
  } else {
    unsubs.push(window.api.ui.onWorkspaceSleep(followWorkspaceSleep))
  }

  unsubs.push(
    window.api.ui.onResumeSleepingAgents(({ worktreeId }) => {
      // Phone opens wake sleeping agents without changing the desktop’s workspace, tab or view.
      requestSleepingAgentWake(worktreeId)
    })
  )
}
