import {
  forceFullViewportPresent,
  forceRepaintThroughRenderPause,
  isSynchronizedOutputHeld,
  requestFullViewportPresent
} from './terminal-render-pause-release'
import { retainTerminalReplayFrame } from './terminal-replay-frame'

// Why a cap: a fit deferred until reveal (or a stuck parse) must never leave a live pane unpainted.
export const TERMINAL_REPLAY_PRESENTATION_MAX_HOLD_MS = 1_000

export type TerminalReplayPresentationTarget = {
  element?: unknown
  rows?: number
  refresh?: (start: number, end: number) => void
  _core?: { refresh?: (start: number, end: number, sync?: boolean) => void }
}

type ReplayPresentation = {
  frame: HTMLElement | null
  opacity: string
  priority: string
  pending: number
  generation: number
  present: boolean
  timeout: ReturnType<typeof setTimeout>
  frameWait: number | null
}

const presentations = new WeakMap<HTMLElement, ReplayPresentation>()

/**
 * Hides the xterm screen behind a copy of its last frame for one structural
 * replay, so the clear and the source-grid paint ahead of the destination fit
 * are never presented. Returns the release; the last release (or the hold cap)
 * repaints and shows the screen again.
 */
export function beginTerminalReplayPresentation(
  terminal: TerminalReplayPresentationTarget
): (present: boolean) => void {
  const element = terminal.element
  if (typeof HTMLElement === 'undefined' || !(element instanceof HTMLElement)) {
    return () => {}
  }
  const screen = element.querySelector<HTMLElement>('.xterm-screen')
  if (!screen) {
    return () => {}
  }
  const refresh = (): void => {
    if (!terminal.rows) {
      return
    }
    if (terminal._core?.refresh) {
      terminal._core.refresh(0, terminal.rows - 1, true)
    } else {
      terminal.refresh?.(0, terminal.rows - 1)
    }
  }
  const unhide = (held: ReplayPresentation, atHoldCap = false): void => {
    clearTimeout(held.timeout)
    if (held.frameWait !== null) {
      cancelAnimationFrame(held.frameWait)
      held.frameWait = null
    }
    if (presentations.get(screen) === held) {
      presentations.delete(screen)
    }
    try {
      const bounds = element.getBoundingClientRect()
      if (held.present && bounds.width > 0 && bounds.height > 0 && terminal.rows) {
        // Only the hold cap may publish an unfinished DEC 2026 frame.
        const presented = atHoldCap
          ? forceFullViewportPresent(terminal)
          : requestFullViewportPresent(terminal)
        if (!presented) {
          refresh()
        }
      }
    } catch {
      // A renderer disposed during replay must not leave a retained screen hidden.
    } finally {
      if (held.opacity) {
        screen.style.setProperty('opacity', held.opacity, held.priority)
      } else {
        screen.style.removeProperty('opacity')
      }
      held.frame?.remove()
    }
  }
  // Why: unhiding mid-DEC 2026 publishes the TUI's half-built frame over the
  // retained copy; the hold cap still unhides a frame that never closes.
  const unhideWhenFrameComplete = (held: ReplayPresentation): void => {
    if (held.frameWait !== null) {
      return
    }
    if (
      held.present &&
      held.frame &&
      isSynchronizedOutputHeld(terminal) &&
      typeof requestAnimationFrame === 'function'
    ) {
      held.frameWait = requestAnimationFrame(() => {
        held.frameWait = null
        if (held.pending === 0 && presentations.get(screen) === held) {
          unhideWhenFrameComplete(held)
        }
      })
      return
    }
    unhide(held)
  }
  let presentation = presentations.get(screen)
  if (!presentation) {
    const capture = retainTerminalReplayFrame(screen, () => {
      // Capturing must not publish an application's unfinished DEC 2026 frame.
      if (isSynchronizedOutputHeld(terminal)) {
        return false
      }
      if (!forceRepaintThroughRenderPause(terminal)) {
        refresh()
      }
      return true
    })
    if (capture.kind === 'unavailable') {
      // Why: a mis-sized intermediate paint beats a blank pane.
      return () => {}
    }
    const created: ReplayPresentation = {
      frame: capture.kind === 'retained' ? capture.frame : null,
      opacity: screen.style.getPropertyValue('opacity'),
      priority: screen.style.getPropertyPriority('opacity'),
      pending: 0,
      generation: 0,
      present: false,
      frameWait: null,
      timeout: setTimeout(() => {
        created.present = true
        unhide(created, true)
      }, TERMINAL_REPLAY_PRESENTATION_MAX_HOLD_MS)
    }
    presentation = created
    presentations.set(screen, created)
    // Same-grid clears also span parser turns; opacity keeps the input focusable.
    screen.style.setProperty('opacity', '0')
  }
  const held = presentation
  const generation = ++held.generation
  held.pending++
  let released = false
  return (present): void => {
    if (released) {
      return
    }
    released = true
    // A reconnect can start a new session before the cancelled one's finally runs.
    if (generation === held.generation) {
      held.present = present
    }
    // The hold cap already showed the screen; a later hold owns its own entry.
    if (--held.pending > 0 || presentations.get(screen) !== held) {
      return
    }
    unhideWhenFrameComplete(held)
  }
}
