type RepaintableTerminal = {
  rows: number
  refresh(start: number, end: number): void
  _core?: { refresh?(start: number, end: number, sync?: boolean): void }
}

type ImageAddedSource = {
  onImageAdded?: (listener: () => void) => { dispose(): void }
}

/** Repaint after image registration: decoder placement can outlive parse/dirty tracking, and throttled or hidden windows may never run xterm’s deferred frame, leaving all but the cursor row stale. */
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
    // Coalesce each decoded burst into one microtask repaint outside addImage.
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
