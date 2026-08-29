import type { Terminal } from '@xterm/xterm'

// Why: xterm draws an open syllable from its own CompositionHelper, which iPad
// Hangul never reaches — it fires no composition events. Korean users expect to
// watch `하` become `한`, so Orca drives xterm's `.composition-view` itself.
//
// Cell metrics come from the public `.xterm-screen` bounds (xterm sizes that
// element to cols x rows cells) rather than `_core._renderService.dimensions`,
// matching `terminal-ime-candidate-anchor.ts` — an xterm bump cannot silently
// move the overlay off the cursor.

/**
 * Returns a renderer for the held Hangul syllable, or a no-op when the terminal
 * has not opened its DOM. Called with '' to hide the overlay.
 */
export function createTerminalIosHangulPreeditRenderer(terminal: Terminal): (text: string) => void {
  const view = terminal.element?.querySelector<HTMLElement>('.composition-view')
  const screen = terminal.element?.querySelector<HTMLElement>('.xterm-screen')
  if (!view || !screen) {
    return () => undefined
  }

  return (text: string): void => {
    if (!text) {
      view.classList.remove('active')
      view.textContent = ''
      return
    }
    view.textContent = text
    view.classList.add('active')

    const rect = screen.getBoundingClientRect()
    const cellWidth = rect.width / terminal.cols
    const cellHeight = rect.height / terminal.rows
    if (!(cellWidth > 0) || !(cellHeight > 0)) {
      return
    }
    const buffer = terminal.buffer.active
    const left = Math.min(buffer.cursorX, terminal.cols - 1) * cellWidth
    view.style.left = `${left}px`
    view.style.top = `${buffer.cursorY * cellHeight}px`
    view.style.height = `${cellHeight}px`
    view.style.lineHeight = `${cellHeight}px`
    view.style.fontFamily = terminal.options.fontFamily ?? ''
    view.style.fontSize = `${terminal.options.fontSize ?? 0}px`
    // Clip at the terminal's right edge instead of overflowing the pane.
    view.style.maxWidth = `${terminal.cols * cellWidth - left}px`
    view.style.overflow = 'hidden'
    // Themed rather than stock #000/#FFF, so light themes keep contrast.
    view.style.background = terminal.options.theme?.background ?? '#000'
    view.style.color = terminal.options.theme?.foreground ?? '#FFF'
  }
}
