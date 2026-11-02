type RepaintableTerminal = {
  rows: number
  refresh(start: number, end: number): void
  _core?: { refresh?(start: number, end: number, sync?: boolean): void }
}

type ImageAddedSource = {
  onImageAdded?: (listener: () => void) => { dispose(): void }
}

/**
 * Repaint the viewport once after the image addon registers an image.
 *
 * Why: an image's rows are dirtied in a write that Orca's synchronous per-write
 * repair may not cover (async decoders even place tiles after that write's
 * parse), so they reach only xterm's frame-debounced refresh. A throttled or
 * hidden window may never run that frame, leaving every image row but the
 * cursor's unpainted until something else repaints the grid.
 */
export function repaintTerminalAfterImageAdded(
  terminal: RepaintableTerminal,
  addon: ImageAddedSource
): { dispose(): void } | null {
  if (typeof addon.onImageAdded !== 'function') {
    return null
  }
  let scheduled = false
  let disposed = false
  const repaint = (): void => {
    scheduled = false
    if (disposed || terminal.rows < 1) {
      return
    }
    try {
      const end = terminal.rows - 1
      if (typeof terminal._core?.refresh === 'function') {
        terminal._core.refresh(0, end, true)
      } else {
        terminal.refresh(0, end)
      }
    } catch {
      // A pane torn down between the image and this microtask has nothing to paint.
    }
  }
  const subscription = addon.onImageAdded(() => {
    if (scheduled || disposed) {
      return
    }
    // Why a microtask: one repaint per decoded burst, outside the addon's addImage call.
    scheduled = true
    queueMicrotask(repaint)
  })
  return {
    dispose: () => {
      disposed = true
      subscription.dispose()
    }
  }
}
