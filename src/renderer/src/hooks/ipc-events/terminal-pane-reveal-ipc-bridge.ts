import { revealTerminalPane } from '@/lib/reveal-terminal-pane'
import { runtimeEnvironmentIdUnlessTwin } from '@/lib/resolve-owner'
import { useAppStore } from '../../store'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import type { TerminalPaneRevealTarget } from '../../../../shared/terminal-pane-reveal'
import {
  isWebTerminalSurfaceTabId,
  toWebTerminalSurfaceTabId
} from '../../../../shared/terminal-surface-id'

/** Map host terminal IDs to prefixed client mirrors before reveal; leaf IDs remain stable. */
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

/** Reveals a pane named as its owning host names it; false when this window lacks the workspace. */
export function revealHostTerminalPane(target: TerminalPaneRevealTarget): boolean {
  return revealTerminalPane({ ...target, tabId: toWindowTabId(target) })
}

export function registerTerminalPaneRevealIpcBridge(unsubs: (() => void)[]): void {
  unsubs.push(
    window.api.ui.onRevealTerminalPane(({ requestId, ...target }) => {
      let revealed = false
      try {
        revealed = revealHostTerminalPane(target)
      } catch (error) {
        console.error('Failed to reveal terminal pane:', error)
      } finally {
        // Why: main holds the caller's RPC open until this reply, so a throw must still answer.
        window.api.ui.replyTerminalPaneReveal({ requestId, revealed })
      }
    })
  )
}
