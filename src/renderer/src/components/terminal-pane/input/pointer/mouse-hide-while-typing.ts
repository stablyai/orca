import type { IDisposable } from '@xterm/xterm'

/** Restore the cursor and remove listeners on disposal. */
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
