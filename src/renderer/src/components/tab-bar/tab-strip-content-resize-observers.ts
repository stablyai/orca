export function bindTabStripContentResizeObservers(
  strip: HTMLElement,
  onResize: () => void
): () => void {
  const resizeObserver = new ResizeObserver(onResize)

  const observeTargets = (): void => {
    resizeObserver.disconnect()
    resizeObserver.observe(strip)
    for (const child of strip.children) {
      if (child instanceof HTMLElement) {
        resizeObserver.observe(child)
      }
    }
  }

  observeTargets()

  const mutationObserver = new MutationObserver(() => {
    observeTargets()
    onResize()
  })
  mutationObserver.observe(strip, { childList: true })

  return () => {
    resizeObserver.disconnect()
    mutationObserver.disconnect()
  }
}
