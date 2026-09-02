export function observeStatusBarContainer(
  node: HTMLDivElement,
  onWidthChange: (width: number) => void
): ResizeObserver {
  const observer = new ResizeObserver((entries) => {
    for (const entry of entries) {
      onWidthChange(entry.contentRect.width)
    }
  })
  observer.observe(node)
  return observer
}
