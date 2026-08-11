/**
 * Run `onChange` only when a `resize` event actually changed the viewport's CSS size.
 *
 * Why: the main process reflows the renderer by briefly nudging the emulated device scale factor
 * (macOS 26) or the native frame (elsewhere) on every reveal, resume, and restore. Chromium fires
 * a real `resize` for those even though `innerWidth`/`innerHeight` are identical, so transient UI
 * bound directly to `resize` gets dismissed with no user interaction.
 */
type ViewportEventTarget = Pick<Window, 'innerWidth' | 'innerHeight'> & {
  addEventListener: (type: 'resize', listener: () => void) => void
  removeEventListener: (type: 'resize', listener: () => void) => void
}

export function addViewportSizeChangeListener(
  onChange: () => void,
  // Why: the suite runs in node with no DOM, so tests pass a stub instead.
  target: ViewportEventTarget = window
): () => void {
  let lastWidth = target.innerWidth
  let lastHeight = target.innerHeight
  const handleResize = (): void => {
    const { innerWidth, innerHeight } = target
    if (innerWidth === lastWidth && innerHeight === lastHeight) {
      return
    }
    lastWidth = innerWidth
    lastHeight = innerHeight
    onChange()
  }
  target.addEventListener('resize', handleResize)
  return () => target.removeEventListener('resize', handleResize)
}
