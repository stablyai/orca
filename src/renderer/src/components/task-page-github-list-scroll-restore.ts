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

/**
 * Drives the reopened GitHub task list back to its remembered offset, retrying until the
 * list is tall enough to reach it. Why no deadline: rows can paint arbitrarily late on a
 * slow host, and abandoning the restore used to also rewrite the remembered offset with
 * the committed 0 — turning a late paint into permanent loss (STA-5949).
 */
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
    // Re-assert the target, not the clamped position: a half-painted list must not
    // downgrade what gets remembered on unmount.
    onScrollTopApplied(target)
    if (Math.abs(committed - target) < SCROLL_MATCH_EPSILON_PX) {
      pendingRestoreRef.current = null
      stop()
    }
  }
  // The container is observed alongside its rows: a pagination bar appearing or a window
  // resize changes only the container, and that alone can make the target reachable.
  observer = new ResizeObserver(restore)
  observer.observe(scrollElement)
  for (const child of scrollElement.children) {
    observer.observe(child)
  }
  // Rows can mount after this layout effect (for example when a cached page settles),
  // so observe child-list changes to cover elements that were not present initially.
  mutationObserver = new MutationObserver(restore)
  mutationObserver.observe(scrollElement, { childList: true, subtree: true })
  restore()
  if (pendingRestoreRef.current === target) {
    frame = window.requestAnimationFrame(restore)
  }
  return stop
}

/**
 * Classifies a scroll on the GitHub list. A scroll carrying exactly what the pending
 * restore last wrote is its own echo and must change nothing; anything else is the user
 * taking over and supersedes the restore — otherwise a target the list can never reach
 * would suppress position saving forever (STA-5949).
 *
 * @returns whether the offset is the user's and should become the remembered position.
 */
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
  // Matching targets is what keeps a write left over from an earlier restore — pending is
  // re-armed from passive effects, after this restore's layout effect — out of the echo.
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
