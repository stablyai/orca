import type { Terminal } from '@xterm/xterm'
import { PaneReparentFrameTracker } from '@/lib/pane-manager/pane-reparent-frame-tracker'

type PreviewBoxFitTerminal = Pick<Terminal, 'rows' | 'buffer'>

/**
 * Scales the preview terminal down to the dialog box it lives in. The terminal
 * keeps the PTY's real cols/rows (replaying serialized ANSI into different
 * dimensions rewraps into garbage), so an oversized frame is transform-scaled
 * and anchored at whichever end keeps the CURSOR row visible: a fresh shell
 * prompts at the TOP of its screen (blind bottom-anchoring clipped it away),
 * while a busy TUI keeps its action at the bottom.
 */
export function createPreviewBoxFit(args: {
  container: HTMLElement
  getTerminal: () => PreviewBoxFitTerminal | null
}): { fit: () => void; schedule: () => void; dispose: () => void } {
  let disposed = false
  const frames = new PaneReparentFrameTracker(() => disposed)
  const fit = (): void => {
    const terminal = args.getTerminal()
    const screen = args.container.querySelector<HTMLElement>('.xterm-screen')
    const box = args.container.parentElement
    if (!screen || !box || !terminal) {
      return
    }
    const scale = Math.min(1, box.clientWidth / Math.max(1, screen.offsetWidth))
    args.container.style.transform = scale < 1 ? `scale(${scale})` : ''
    const cellHeight = screen.offsetHeight / Math.max(1, terminal.rows)
    const cursorBottom = (terminal.buffer.active.cursorY + 1) * cellHeight * scale
    const anchorTop = cursorBottom <= box.clientHeight
    box.style.alignItems = anchorTop ? 'flex-start' : 'flex-end'
    args.container.style.transformOrigin = anchorTop ? 'top left' : 'bottom left'
  }

  // Re-fit after every parsed write (cursor may move ends); rAF coalesces.
  let scheduled = false
  const schedule = (): void => {
    if (disposed || scheduled) {
      return
    }
    scheduled = true
    frames.request(() => {
      scheduled = false
      fit()
    })
  }

  return {
    fit,
    schedule,
    dispose: (): void => {
      if (disposed) {
        return
      }
      disposed = true
      frames.cancelPending()
    }
  }
}
