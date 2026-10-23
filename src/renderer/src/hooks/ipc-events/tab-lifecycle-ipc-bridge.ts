import { dispatchWorkspaceTabCommand } from '@/lib/workspace-tab-commands'
import { replayAppKeyDown } from '@/lib/app-keyboard-router'
import { resolveFloatingWorkspaceBrowserWorkspaceId } from '@/lib/floating-workspace-terminal-actions'
import {
  dispatchFloatingWorkspaceGuestClose,
  dispatchFloatingWorkspaceGuestSelectIndex
} from '@/lib/floating-workspace-guest-bridge'

import { useAppStore } from '../../store'

export function registerTabLifecycleIpcBridge(unsubs: (() => void)[]): void {
  unsubs.push(
    // Why: a focused page is its own process, so main hands its tab chords back to run through
    // the same app shortcut owners a key pressed in Orca's own UI reaches.
    window.api.ui.onBrowserPageTabShortcut((input) =>
      replayAppKeyDown(
        Object.assign(
          new KeyboardEvent('keydown', {
            key: input.key,
            code: input.code,
            altKey: input.alt,
            metaKey: input.meta,
            ctrlKey: input.control,
            shiftKey: input.shift,
            cancelable: true
          }),
          // Why: keybinding matching reads this field, so a double-tap binding matches the replay too.
          { doubleTapModifier: input.doubleTapModifier }
        )
      )
    )
  )
  unsubs.push(
    window.api.ui.onCloseActiveTab((payload) => {
      dispatchWorkspaceTabCommand({
        type: 'close',
        ...(payload?.sourceId
          ? { target: { kind: 'browser-source', sourceId: payload.sourceId } as const }
          : {})
      })
    })
  )

  unsubs.push(
    window.api.ui.onCloseFloatingItem(({ sourceId }) => {
      // Main forwards the guest's browser *page* id; resolve it to the owning live floating
      // browser workspace (the id space the panel closes by), then hand off to the mounted
      // panel's own close closure (pin guard + reclaim intent). Stale id = no-op.
      const workspaceId = resolveFloatingWorkspaceBrowserWorkspaceId(
        useAppStore.getState(),
        sourceId
      )
      if (!workspaceId) {
        return
      }
      dispatchFloatingWorkspaceGuestClose({ sourceId: workspaceId })
    })
  )
  unsubs.push(
    window.api.ui.onSelectFloatingIndex(({ index }) => {
      dispatchFloatingWorkspaceGuestSelectIndex({ index })
    })
  )

  unsubs.push(
    window.api.ui.onSwitchRecentTab(() => {
      dispatchWorkspaceTabCommand({ type: 'previous-recent' })
    })
  )
}
