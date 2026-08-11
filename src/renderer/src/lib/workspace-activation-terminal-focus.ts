import { useAppStore } from '@/store'
import { focusTerminalTabSurface } from '@/lib/focus-terminal-tab-surface'
import { focusRuntimeTerminalSurface } from '@/runtime/sync-runtime-graph'
import type { ActivateAndRevealResult } from '@/lib/worktree-activation'

function resolveActivatedWorkspaceTerminalTabId(
  worktreeId: string,
  activation: ActivateAndRevealResult | false
): string | null {
  const state = useAppStore.getState()
  if (activation && activation.primaryTabId) {
    return activation.primaryTabId
  }
  if (
    state.activeWorktreeId !== worktreeId ||
    state.activeView !== 'terminal' ||
    state.activeTabType !== 'terminal'
  ) {
    return null
  }
  return state.activeTabId
}

// Why: returns false when the destination's restored surface is not a terminal, so callers can
// fall back instead of focusing an unrelated worktree's mounted-but-hidden terminal (#9939).
export function queueWorkspaceActivationTerminalFocus(
  worktreeId: string,
  activation: ActivateAndRevealResult | false
): boolean {
  const tabId = resolveActivatedWorkspaceTerminalTabId(worktreeId, activation)
  if (!tabId) {
    return false
  }

  requestAnimationFrame(() => {
    const state = useAppStore.getState()
    if (
      state.activeWorktreeId !== worktreeId ||
      state.activeView !== 'terminal' ||
      state.activeTabType !== 'terminal' ||
      state.activeTabId !== tabId
    ) {
      return
    }

    // Why: creation closes a Radix dialog immediately after activation. Queue
    // focus past that close so focus restoration cannot leave the user on the
    // removed composer field after Cmd/Ctrl+Enter.
    if (!focusRuntimeTerminalSurface(tabId)) {
      focusTerminalTabSurface(tabId)
    }
  })
  return true
}
