import { useEffect, useLayoutEffect, useRef } from 'react'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { isEditableTarget } from '@/lib/editable-target'
import { getShortcutPlatform } from '@/lib/shortcut-platform'
import { matchTiledAgentsShortcut } from '@/components/tab-group/tiled-agents-shortcuts'
import { focusTerminalTabSurface } from '@/lib/focus-terminal-tab-surface'
import type { KeybindingOverrides } from '../../../shared/keybindings'

type TiledAgentsShortcutState = {
  activeWorktreeId: string | null
  keybindings: KeybindingOverrides
}

/** After focusAgentCardByIndex moves activeGroupIdByWorktree, route real DOM focus to that
 *  pane's surface. Terminal leaves need this explicit call, mirroring ordinary tab-number
 *  shortcuts' focusTerminalTabSurface; native-chat agent panes already recover composer focus
 *  reactively from the isFocusedGroup reveal edge once the active group moves. */
function routeTiledPaneFocusToSurface(
  state: Pick<AppState, 'activeGroupIdByWorktree' | 'groupsByWorktree' | 'unifiedTabsByWorktree'>,
  worktreeId: string
): void {
  const groupId = state.activeGroupIdByWorktree[worktreeId]
  const group = state.groupsByWorktree[worktreeId]?.find((candidate) => candidate.id === groupId)
  const tab = state.unifiedTabsByWorktree[worktreeId]?.find(
    (candidate) => candidate.id === group?.activeTabId
  )
  if (tab?.contentType === 'terminal') {
    focusTerminalTabSurface(tab.entityId)
  }
}

/** Window-level Mod+Alt+1..9 / Mod+Alt+Enter listener, mounted once at the app level. */
export function useTiledAgentsShortcuts(): void {
  const enabled = useAppStore((s) => s.settings?.experimentalTiledAgents === true)
  const state: TiledAgentsShortcutState = {
    activeWorktreeId: useAppStore((s) => s.activeWorktreeId),
    keybindings: useAppStore((s) => s.keybindings)
  }
  const stateRef = useRef(state)
  // Why useLayoutEffect: mirror must be current before the next keydown can read it.
  useLayoutEffect(() => {
    stateRef.current = state
  })

  useEffect(() => {
    // Why gate registration here, not inside the handler: a disabled experiment must leave zero
    // keydown listeners installed, not merely a handler that bails (R2 global-off parity).
    if (!enabled) {
      return
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (isEditableTarget(event.target)) {
        return
      }
      const current = stateRef.current
      const worktreeId = current.activeWorktreeId
      if (!worktreeId) {
        return
      }
      const matched = matchTiledAgentsShortcut(
        {
          key: event.key,
          code: event.code,
          altKey: event.altKey,
          metaKey: event.metaKey,
          ctrlKey: event.ctrlKey,
          shiftKey: event.shiftKey
        },
        getShortcutPlatform(),
        current.keybindings
      )
      if (!matched) {
        return
      }
      // Why: a held Mod+Alt+Enter repeats keydown, and each repeat toggling maximize would make
      // the final state depend on how long the key was held. Focus-by-index is idempotent, so it
      // stays unguarded.
      if (matched.type === 'toggleMaximize' && event.repeat) {
        return
      }
      const store = useAppStore.getState()
      let handled = false
      if (matched.type === 'focusPane') {
        handled = store.focusAgentCardByIndex(worktreeId, matched.index)
        if (handled) {
          routeTiledPaneFocusToSurface(useAppStore.getState(), worktreeId)
        }
      } else if (matched.type === 'toggleMaximize') {
        handled = store.toggleMaximizedAgentCard(worktreeId) !== null
      }
      if (handled) {
        event.preventDefault()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [enabled])
}
