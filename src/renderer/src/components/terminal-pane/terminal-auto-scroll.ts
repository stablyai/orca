import type { Terminal } from '@xterm/xterm'
import { cancelDeferredScrollRestore } from '@/lib/pane-manager/pane-scroll'
import {
  markTerminalFollowOutput,
  markTerminalPinnedViewport,
  syncTerminalScrollIntentFromViewport
} from '@/lib/pane-manager/terminal-scroll-intent'

type FollowTerminalOutputOptions = {
  focus?: boolean
}

function scrollToBottomSafely(terminal: Terminal): boolean {
  try {
    terminal.scrollToBottom()
    return true
  } catch (error) {
    // Why: WebGL teardown can temporarily detach xterm's render dimensions;
    // follow intent must still survive so the next parsed output can apply it.
    if (error instanceof TypeError && /dimensions/.test(error.message)) {
      return false
    }
    throw error
  }
}

export function followTerminalOutput(
  terminal: Terminal,
  { focus = false }: FollowTerminalOutputOptions = {}
): void {
  cancelDeferredScrollRestore(terminal)
  markTerminalFollowOutput(terminal)
  if (scrollToBottomSafely(terminal)) {
    syncTerminalScrollIntentFromViewport(terminal)
  }
  if (focus) {
    terminal.focus()
  }
}

export function pinTerminalOutput(terminal: Terminal): void {
  // Why: disabling follow-output freezes the viewport visible at the time of
  // the command, even if an older deferred restore is still queued.
  cancelDeferredScrollRestore(terminal)
  markTerminalPinnedViewport(terminal)
}
