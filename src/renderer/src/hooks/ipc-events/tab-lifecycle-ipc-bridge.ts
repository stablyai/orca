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
      // Resolve main’s page ID to its floating browser workspace, then use the mounted panel’s pin/reclaim-aware close; stale IDs no-op.
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
  unsubs.push(
    window.api.ui.onFocusTabGroup?.((direction, sourcePageId) => {
      dispatchWorkspaceTabCommand({
        type: 'focus-group',
        direction,
        ...(sourcePageId ? { sourcePageId } : {})
      })
    }) ?? (() => {})
  )
}
