import type { RefObject } from 'react'

// Committed scrollTop is only exact to the sub-pixel; treat sub-pixel drift as a hit.
const SCROLL_MATCH_EPSILON_PX = 1

/** What a restore last committed, tagged with its target so a later restore can't inherit it. */
export type GitHubListRestoreWrite = {
  target: number
  committed: number
}

export type GitHubListScrollRestoreOptions = {
  /** Remembered offset the reopened list must land on. */
  target: number
  scrollElementRef: RefObject<HTMLElement | null>
  /** Holds `target` until it is reached or a user scroll supersedes it. */
  pendingRestoreRef: RefObject<number | null>
  /** Lets the scroll handler tell the restore's own write apart from a user gesture. */
  restoreWriteRef: RefObject<GitHubListRestoreWrite | null>
  onScrollTopApplied: (scrollTop: number) => void
}

/** Retry until late-painted rows can reach the remembered target or the user takes over; a deadline would permanently save a clamped offset. */
export function startGitHubListScrollRestore({
  target,
  scrollElementRef,
  pendingRestoreRef,
  restoreWriteRef,
  onScrollTopApplied
}: GitHubListScrollRestoreOptions): () => void {
  const scrollElement = scrollElementRef.current
  if (!scrollElement) {
    return () => {}
  }
  restoreWriteRef.current = null
  let frame: number | null = null
  let observer: ResizeObserver | null = null
  let mutationObserver: MutationObserver | null = null
  const stop = (): void => {
    if (frame !== null) {
      window.cancelAnimationFrame(frame)
      frame = null
    }
    observer?.disconnect()
    observer = null
    mutationObserver?.disconnect()
    mutationObserver = null
  }
  const restore = (): void => {
    const element = scrollElementRef.current
    if (!element || pendingRestoreRef.current !== target) {
      stop()
      return
    }
    element.scrollTop = target
    const committed = element.scrollTop
    restoreWriteRef.current = { target, committed }
    // Remember the target rather than the clamped position so partial paint cannot lose the offset on unmount.
    onScrollTopApplied(target)
    if (Math.abs(committed - target) < SCROLL_MATCH_EPSILON_PX) {
      pendingRestoreRef.current = null
      stop()
    }
  }
  // Observe the container too: pager/window resizes can make the target reachable without changing rows.
  observer = new ResizeObserver(restore)
  observer.observe(scrollElement)
  for (const child of scrollElement.children) {
    observer.observe(child)
  }
  // Observe child additions because rows can mount after this layout effect.
  mutationObserver = new MutationObserver(restore)
  mutationObserver.observe(scrollElement, { childList: true, subtree: true })
  restore()
  if (pendingRestoreRef.current === target) {
    frame = window.requestAnimationFrame(restore)
  }
  return stop
}

/** Ignore pending restore echoes; other scrolls supersede restoration and become the remembered position. */
export function supersedeGitHubListScrollRestore({
  scrollTop,
  pendingRestoreRef,
  restoreWriteRef
}: {
  scrollTop: number
  pendingRestoreRef: RefObject<number | null>
  restoreWriteRef: RefObject<GitHubListRestoreWrite | null>
}): boolean {
  const write = restoreWriteRef.current
  // Match targets because passive re-arming can leave the preceding restore’s write visible to this layout effect.
  if (
    write !== null &&
    write.target === pendingRestoreRef.current &&
    Math.abs(scrollTop - write.committed) < SCROLL_MATCH_EPSILON_PX
  ) {
    return false
  }
  pendingRestoreRef.current = null
  restoreWriteRef.current = null
  return true
}
