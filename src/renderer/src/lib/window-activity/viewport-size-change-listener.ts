/** Ignore resize events from reveal/resume reflows that nudge device scale or native frames without changing viewport CSS size, so transient UI stays open. */
type ViewportEventTarget = Pick<Window, 'innerWidth' | 'innerHeight'> & {
  addEventListener: (type: 'resize', listener: () => void) => void
  removeEventListener: (type: 'resize', listener: () => void) => void
}

export function addViewportSizeChangeListener(
  onChange: () => void,
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
