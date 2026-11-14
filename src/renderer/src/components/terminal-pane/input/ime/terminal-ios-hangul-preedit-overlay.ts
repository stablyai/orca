import type { Terminal } from '@xterm/xterm'

// iPad hardware Hangul fires no composition events, so render the held syllable through xterm’s view using public screen bounds rather than private dimensions.

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
    view.style.maxWidth = `${terminal.cols * cellWidth - left}px`
    view.style.overflow = 'hidden'
    view.style.background = terminal.options.theme?.background ?? '#000'
    view.style.color = terminal.options.theme?.foreground ?? '#FFF'
  }
}
