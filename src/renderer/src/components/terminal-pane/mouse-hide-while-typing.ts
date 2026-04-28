import type { IDisposable } from '@xterm/xterm'

/** Installs mouse-hide-while-typing behavior on a single terminal pane.
 *  Returns an IDisposable that cleans up listeners and restores cursor style. */
export function installMouseHideWhileTyping(
  terminal: { onData: (callback: () => void) => IDisposable },
  container: HTMLElement
): IDisposable {
  const hideOnData = terminal.onData(() => {
    container.style.cursor = 'none'
  })

  const showOnMove = (): void => {
    container.style.cursor = ''
  }
  container.addEventListener('mousemove', showOnMove)

  return {
    dispose: () => {
      hideOnData.dispose()
      container.removeEventListener('mousemove', showOnMove)
      container.style.cursor = ''
    }
  }
}
