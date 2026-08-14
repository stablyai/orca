import { useEffect, useRef } from 'react'
import type { GitHistoryCursor, GitHistoryResult } from '../../../../shared/git-history'

// Why: start the next page while the trigger is still below the fold rather than once it lands on
// it. A page costs one `git log` spawn, and that spawn is not free everywhere — measured at ~122ms
// on Windows with Defender resident, against ~10ms on Linux — so the fetch needs a head start to
// stay invisible. Roughly nine collapsed rows of runway at the panel's 26px row height.
export const GIT_HISTORY_AUTO_LOAD_MARGIN_PX = 240

// Identifies the page a cursor would fetch. Auto-loading the same one twice is the failure mode
// that matters: the trigger stays mounted while a request is in flight and after one fails.
function gitHistoryCursorKey(cursor: GitHistoryCursor | undefined): string | undefined {
  return cursor ? `${cursor.anchor}:${cursor.loaded}` : undefined
}

/**
 * Fetches the next page of commits when the load trigger scrolls near the bottom of the panel.
 *
 * The trigger stays a real button, and this only presses it: keyboard users, a host too old to page,
 * and any environment without `IntersectionObserver` all keep the manual path unchanged.
 *
 * Auto-loading is allowed once per cursor. That single rule covers both hazards, which are the same
 * hazard seen twice — the trigger is still mounted and still in view after a page lands, and again
 * after a page fails. Without it the panel would either page to the end of history unattended or
 * retry a failing page for as long as it stayed on screen.
 *
 * Every landed page re-subscribes rather than re-reading a remembered visibility. `isIntersecting`
 * is only ever known from the last entry the observer delivered, and a page that pushes the trigger
 * out of view has not delivered one yet at the moment the page lands — acting on the remembered
 * value there would fetch a page the user never scrolled to. Re-observing answers the question
 * against the live layout instead. When the trigger genuinely is still in view — a short list, or a
 * page that added no height — the fresh entry says so and the next page loads, which is the point.
 */
export function useGitHistoryAutoLoad({
  trigger,
  scrollElement,
  result,
  enabled,
  onLoadMore
}: {
  // The "Load more" button. Observing the real control means auto-loading and clicking cannot
  // disagree about when another page is available.
  trigger: HTMLElement | null
  scrollElement: HTMLElement | null
  // The page on screen. Its identity — not just the cursor it carries — is what marks a new page,
  // because a refresh can land the very same cursor the previous walk ended on.
  result: GitHistoryResult | undefined
  // False while a request is in flight or when there is nothing further to load.
  enabled: boolean
  onLoadMore: () => void
}): void {
  const cursorKey = gitHistoryCursorKey(result?.nextCursor)
  const autoLoadedKeyRef = useRef<string | undefined>(undefined)

  // Read through a ref so the observer subscribes on page and layout inputs alone. Re-subscribing
  // on every render would make the observer's first entry, not the user's scrolling, decide when
  // to fetch.
  const loadIfDueRef = useRef<() => void>(() => {})
  loadIfDueRef.current = () => {
    if (!enabled || !cursorKey || autoLoadedKeyRef.current === cursorKey) {
      return
    }
    autoLoadedKeyRef.current = cursorKey
    onLoadMore()
  }

  // Why: a replaced list is a different walk, and the cursor it hands back can repeat one already
  // spent on the walk it replaced — a refresh landing on the same HEAD produces exactly that.
  // Keying the reset on the cursor would miss that case and leave auto-loading dead until the user
  // pressed the button once by hand, so it keys on the page itself.
  useEffect(() => {
    if (!result?.continuedCursor) {
      autoLoadedKeyRef.current = undefined
    }
  }, [result])

  useEffect(() => {
    // Why: degrade to the manual button rather than throw. This runs in the renderer, but the
    // panel is also mounted under test environments that ship no IntersectionObserver.
    if (!trigger || !scrollElement || typeof IntersectionObserver === 'undefined') {
      return
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.at(-1)?.isIntersecting) {
          loadIfDueRef.current()
        }
      },
      { root: scrollElement, rootMargin: `0px 0px ${GIT_HISTORY_AUTO_LOAD_MARGIN_PX}px 0px` }
    )
    observer.observe(trigger)
    return () => {
      observer.disconnect()
    }
    // Why `result` is a dependency: see the re-subscribe note above.
  }, [trigger, scrollElement, result])
}
