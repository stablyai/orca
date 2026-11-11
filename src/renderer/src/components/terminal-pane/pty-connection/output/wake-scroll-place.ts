import type { Terminal } from '@xterm/xterm'
import { syncTerminalScrollIntentFromViewport } from '@/lib/pane-manager/terminal-scroll-intent'
import {
  beginTerminalScrollIntentBufferRebuild,
  endTerminalScrollIntentBufferRebuild,
  onTerminalScrollIntentBufferRebuildComplete
} from '@/lib/pane-manager/terminal-scroll-intent-rebuild'
import {
  cancelDeferredScrollRestore,
  cancelPendingFitScrollRestore
} from '@/lib/pane-manager/pane-scroll'

/**
 * WAKE-SCROLLBACK-SCROLL: puts a woken pane back on the line the person scrolled to. The person's
 * place wins: restores captured before it (a remount's first fit, at the bottom) are dropped, the
 * scroll runs with intent enforcement paused (its synchronous "follow output" would snap back), and
 * the place is recorded as a pin for the fits still to come. Inside the replay's own rebuild (whose
 * completion restores the intent captured before it), it runs after that, last.
 */
export function keepWakeScrollPlace(terminal: Terminal): (line: number) => void {
  const place = (line: number): void => {
    cancelDeferredScrollRestore(terminal)
    cancelPendingFitScrollRestore(terminal)
    beginTerminalScrollIntentBufferRebuild(terminal)
    try {
      terminal.scrollToLine(line)
    } finally {
      endTerminalScrollIntentBufferRebuild(terminal)
    }
    syncTerminalScrollIntentFromViewport(terminal, { allowBufferShrink: true })
  }
  return (line) => {
    onTerminalScrollIntentBufferRebuildComplete(terminal, (completed) => {
      if (!completed) {
        return
      }
      place(line)
      // The replay ran at the host's grid; the pane's own fit follows and keeps the pin by its
      // distance from the bottom, which moves the line when the row count changes. Once, after it.
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          const { viewportY, baseY } = terminal.buffer.active
          if (viewportY < baseY && viewportY !== line) {
            place(line)
          }
        })
      )
    })
  }
}
