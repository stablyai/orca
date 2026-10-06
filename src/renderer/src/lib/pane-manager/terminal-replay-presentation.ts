import {
  forceFullViewportPresent,
  requestFullViewportPresent
} from './terminal-render-pause-release'
import { retainTerminalReplayFrame } from './terminal-replay-frame'

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
}

const presentations = new WeakMap<HTMLElement, ReplayPresentation>()

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
  let presentation = presentations.get(screen)
  if (!presentation) {
    presentation = {
      frame: retainTerminalReplayFrame(screen, () => {
        // Capturing must not end an application's DEC 2026 frame.
        if (!requestFullViewportPresent(terminal)) {
          refresh()
        }
      }),
      opacity: screen.style.getPropertyValue('opacity'),
      priority: screen.style.getPropertyPriority('opacity'),
      pending: 0,
      generation: 0,
      present: false
    }
    presentations.set(screen, presentation)
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
    if (--held.pending > 0) {
      return
    }
    presentations.delete(screen)
    try {
      const bounds = element.getBoundingClientRect()
      if (held.present && bounds.width > 0 && bounds.height > 0 && terminal.rows) {
        if (!forceFullViewportPresent(terminal)) {
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
}
