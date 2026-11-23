import { revealTerminalPane } from '@/lib/workspace/activation/reveal-terminal-pane'

export function registerTerminalPaneRevealIpcBridge(unsubs: (() => void)[]): void {
  unsubs.push(
    window.api.ui.onRevealTerminalPane(({ requestId, ...target }) => {
      let revealed = false
      try {
        revealed = revealTerminalPane(target)
      } catch (error) {
        console.error('Failed to reveal terminal pane:', error)
      } finally {
        // Why: main holds the caller's RPC open until this reply, so a throw must still answer.
        window.api.ui.replyTerminalPaneReveal({ requestId, revealed })
      }
    })
  )
}
