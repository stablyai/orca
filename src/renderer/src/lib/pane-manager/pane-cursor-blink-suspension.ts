import type { Terminal } from '@xterm/xterm'

/**
 * Park `cursorBlink` while a pane is hidden.
 *
 * Why: a retained hidden pane (`terminal-webgl-hidden-retention.ts`) keeps a live
 * WebglRenderer, and the only thing that stops its 600 ms blink timer is
 * `WebglRenderer.handleBlur()` — reached only from a real DOM blur event. Today
 * that arrives incidentally, because `display:none`/`visibility:hidden` move focus;
 * under `opacity:0` without `inert` (TerminalOverlaySlot's startup probe) it never
 * fires, `Terminal.blur()` is a no-op on a textarea that is not the active element,
 * and the pane blinks — redrawing its whole cursor row through
 * `WebglRenderer._updateModel` — until the 5-minute idle timeout.
 *
 * `cursorBlink` is the public option that tears the timer down
 * (`RenderService.handleOptionsChanged` -> `WebglRenderer._updateCursorBlink`), so
 * "a hidden pane does not blink" stops depending on which CSS hid it.
 *
 * Not unconditional, though: `_updateCursorBlink` resolves
 * `decPrivateModes.cursorBlink ?? options.cursorBlink`, and DECSCUSR with a
 * blinking style (`CSI 5 SP q`) pins that DEC mode. On a pane whose shell or agent
 * has emitted one, parking the option here has no effect and the hidden pane keeps
 * blinking. Making this deterministic means clearing the DEC mode too.
 *
 * Resume restores the parked value rather than the settings value, so a pane that
 * was not blinking before the hide never comes back blinking.
 */
const parkedCursorBlink = new WeakMap<Terminal, boolean>()

export function suspendTerminalCursorBlink(terminal: Terminal): void {
  if (parkedCursorBlink.has(terminal)) {
    return
  }
  parkedCursorBlink.set(terminal, terminal.options.cursorBlink === true)
  terminal.options.cursorBlink = false
}

/** Restores the pre-suspend blink state. No-op on a terminal that was never suspended. */
export function resumeTerminalCursorBlink(terminal: Terminal): void {
  if (!parkedCursorBlink.has(terminal)) {
    return
  }
  const restored = parkedCursorBlink.get(terminal) === true
  parkedCursorBlink.delete(terminal)
  terminal.options.cursorBlink = restored
}

/**
 * Settings-driven blink writes land on the parked value while a pane is suspended;
 * writing the option directly would re-arm the blink timer behind a hidden surface
 * until the next reveal.
 */
export function setTerminalCursorBlinkOption(terminal: Terminal, enabled: boolean): void {
  if (parkedCursorBlink.has(terminal)) {
    parkedCursorBlink.set(terminal, enabled)
    return
  }
  terminal.options.cursorBlink = enabled
}

export function isTerminalCursorBlinkSuspended(terminal: Terminal): boolean {
  return parkedCursorBlink.has(terminal)
}
