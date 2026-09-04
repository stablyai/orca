import type { Terminal } from '@xterm/xterm'

type PreviewBoxFitTerminal = Pick<Terminal, 'rows' | 'buffer'>

/** `width` clips tall buffers so the cursor row stays readable; `both` because a claim clamped at the 8-row floor overflows a grid card. */
export type PreviewBoxFitAxis = 'width' | 'both'

// Frames to keep re-measuring while the layout stays unusable, so a preview
// whose first fit ran detached still converges without any external trigger.
const UNMEASURABLE_RETRY_FRAMES = 40

/** Transform-scales an oversized frame down (never up; that blurs) anchored at the end holding the CURSOR row, since a fresh shell prompts at the top. */
export function createPreviewBoxFit(args: {
  container: HTMLElement
  getTerminal: () => PreviewBoxFitTerminal | null
  fitAxis?: PreviewBoxFitAxis
}): { fit: () => void; schedule: () => void } {
  const fitAxis = args.fitAxis ?? 'width'
  let scheduled = false
  let retriesLeft = UNMEASURABLE_RETRY_FRAMES

  const fit = (): void => {
    const terminal = args.getTerminal()
    const screen = args.container.querySelector<HTMLElement>('.xterm-screen')
    const box = args.container.parentElement
    if (!screen || !box || !terminal) {
      return
    }
    // Why bail without writing: a detached or not-yet-laid-out node measures 0,
    // and the old divide-by-max(1, 0) silently produced scale 1 — wiping a
    // correct transform and anchoring off a zero cell height. Keeping the last
    // good fit is what survives a dnd reorder, which moves DOM nodes and fires
    // the ResizeObserver at size 0.
    if (
      screen.offsetWidth <= 0 ||
      screen.offsetHeight <= 0 ||
      box.clientWidth <= 0 ||
      box.clientHeight <= 0 ||
      terminal.rows <= 0
    ) {
      if (retriesLeft > 0) {
        retriesLeft--
        schedule()
      }
      return
    }
    retriesLeft = UNMEASURABLE_RETRY_FRAMES

    const scaleX = box.clientWidth / screen.offsetWidth
    const scaleY = box.clientHeight / screen.offsetHeight
    const scale = fitAxis === 'both' ? Math.min(1, scaleX, scaleY) : Math.min(1, scaleX)
    args.container.style.transform = scale < 1 ? `scale(${scale})` : ''
    const cellHeight = screen.offsetHeight / terminal.rows
    const cursorBottom = (terminal.buffer.active.cursorY + 1) * cellHeight * scale
    const anchorTop = cursorBottom <= box.clientHeight
    box.style.alignItems = anchorTop ? 'flex-start' : 'flex-end'
    args.container.style.transformOrigin = anchorTop ? 'top left' : 'bottom left'
  }

  // Re-fit after every parsed write (cursor may move ends); rAF coalesces.
  const schedule = (): void => {
    if (scheduled) {
      return
    }
    scheduled = true
    requestAnimationFrame(() => {
      scheduled = false
      fit()
    })
  }

  return { fit, schedule }
}
