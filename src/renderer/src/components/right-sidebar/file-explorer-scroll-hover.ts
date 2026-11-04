/** Marks the explorer viewport while its rows are moving under a stationary pointer. */
export const FILE_EXPLORER_SCROLLING_ATTR = 'data-file-explorer-scrolling'

/** How long after the last scroll event before row hover is allowed again. */
export const FILE_EXPLORER_SCROLL_HOVER_IDLE_MS = 120

/**
 * Suppress row hover for the whole gesture, including wheel scrolling and the
 * browser's middle-button autoscroll. Both move rows under a pointer that does
 * not move, and `transition-colors` turns each brief :hover into a strobe (#22692).
 */
export function bindFileExplorerScrollHover(container: HTMLElement): () => void {
  let idleTimer: ReturnType<typeof setTimeout> | null = null

  const markScrolling = (): void => {
    container.setAttribute(FILE_EXPLORER_SCROLLING_ATTR, '')
    if (idleTimer !== null) {
      clearTimeout(idleTimer)
    }
    idleTimer = setTimeout(() => {
      idleTimer = null
      container.removeAttribute(FILE_EXPLORER_SCROLLING_ATTR)
    }, FILE_EXPLORER_SCROLL_HOVER_IDLE_MS)
  }

  container.addEventListener('scroll', markScrolling, { passive: true })
  return () => {
    container.removeEventListener('scroll', markScrolling)
    if (idleTimer !== null) {
      clearTimeout(idleTimer)
    }
    container.removeAttribute(FILE_EXPLORER_SCROLLING_ATTR)
  }
}
