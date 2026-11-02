import { revealTerminalPane } from '@/lib/reveal-terminal-pane'
import { runtimeEnvironmentIdUnlessTwin } from '@/lib/resolve-owner'
import { useAppStore } from '../../store'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import type { TerminalPaneRevealTarget } from '../../../../shared/terminal-pane-reveal'
import {
  isWebTerminalSurfaceTabId,
  toWebTerminalSurfaceTabId
} from '../../../../shared/terminal-surface-id'

/**
 * External callers name a tab as its owning host does. This window mirrors a paired server's
 * terminal tab under a prefixed id, with the same leaf ids, so map the tab before revealing it.
 */
function toWindowTabId(target: TerminalPaneRevealTarget): string {
  const host = parseExecutionHostId(target.executionHostId)
  const environmentId = host
    ? host.kind === 'runtime'
      ? host.environmentId
      : null
    : // Why: reveal only focuses a tab; a twin keeps the id the caller named.
      runtimeEnvironmentIdUnlessTwin(useAppStore.getState(), target.worktreeId)
  return environmentId && !isWebTerminalSurfaceTabId(target.tabId)
    ? toWebTerminalSurfaceTabId(target.tabId)
    : target.tabId
}

export function registerTerminalPaneRevealIpcBridge(unsubs: (() => void)[]): void {
  unsubs.push(
    window.api.ui.onRevealTerminalPane(({ requestId, ...target }) => {
      let revealed = false
      try {
        revealed = revealTerminalPane({ ...target, tabId: toWindowTabId(target) })
      } catch (error) {
        console.error('Failed to reveal terminal pane:', error)
      } finally {
        // Why: main holds the caller's RPC open until this reply, so a throw must still answer.
        window.api.ui.replyTerminalPaneReveal({ requestId, revealed })
      }
    })
  )
}
