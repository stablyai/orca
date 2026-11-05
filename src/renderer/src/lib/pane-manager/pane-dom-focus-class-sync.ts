import { PaneReparentFrameTracker } from './pane-reparent-frame-tracker'

export function attachDomRendererFocusClassSync(
  terminalElement: HTMLElement | undefined
): () => void {
  if (!terminalElement) {
    return () => undefined
  }

  let disposed = false
  const frames = new PaneReparentFrameTracker(() => disposed)

  const sync = (): void => {
    const rows = terminalElement.querySelector<HTMLElement>('.xterm-rows')
    if (!rows) {
      return
    }
    // xterm 6 can focus the root without marking DOM rows; cursor-blink CSS needs their xterm-focus class too.
    rows.classList.toggle('xterm-focus', terminalElement.classList.contains('focus'))
  }

  const scheduleSync = (): void => {
    if (disposed) {
      return
    }
    sync()
    if (!disposed) {
      frames.request(sync)
    }
  }

  const observer = new MutationObserver(scheduleSync)
  observer.observe(terminalElement, { attributes: true, attributeFilter: ['class'] })
  terminalElement.addEventListener('focusin', scheduleSync)
  terminalElement.addEventListener('focusout', scheduleSync)
  scheduleSync()

  return () => {
    disposed = true
    frames.cancelPending()
    observer.disconnect()
    terminalElement.removeEventListener('focusin', scheduleSync)
    terminalElement.removeEventListener('focusout', scheduleSync)
  }
}
