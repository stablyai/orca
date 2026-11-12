import { useEffect, useLayoutEffect, useRef } from 'react'
import { useAppStore } from '@/store/index'
import { automationsPageLocationKey } from '../../store/slices/ui/automations-page-location'
import type { AutomationsPageLocation } from './automation-page-state'
import type { AutomationsPageNavigation } from './automations-page-navigation'

/** Record each settled sub-page in app history and apply back/forward replays. */
export function useAutomationsPageHistory({
  location,
  navigation
}: {
  /** Null while the page is resolving (deep link loading, run not found). */
  location: AutomationsPageLocation | null
  navigation: Pick<AutomationsPageNavigation, 'goToLocation'>
}): void {
  const request = useAppStore((s) => s.automationsPageLocationRequest)
  const setRequest = useAppStore((s) => s.setAutomationsPageLocationRequest)
  const record = useAppStore((s) => s.recordAutomationsPageVisit)

  const goToLocationRef = useRef(navigation.goToLocation)
  useEffect(() => {
    goToLocationRef.current = navigation.goToLocation
  })
  useEffect(() => {
    if (!request) {
      return
    }
    setRequest(null)
    goToLocationRef.current(request)
  }, [request, setRequest])

  const key = location ? automationsPageLocationKey(location) : null
  const locationRef = useRef(location)
  useEffect(() => {
    locationRef.current = location
  })
  useEffect(() => {
    // Why: a replay's location matches the entry it came from, so recording it is a no-op;
    // skipping while a request is pending keeps intermediate states out of history.
    if (key === null || request || !locationRef.current) {
      return
    }
    record(locationRef.current)
  }, [key, record, request])
}

export type AutomationsPageFocusTarget = {
  /** Changes whenever the visible sub-page changes. */
  key: string
  /** Pages this one is a child of; returning to one restores focus to `returnSelector`. */
  parents: readonly string[]
  /** This page's entry in its parent (its list row, rail item, or "All runs" link). */
  returnSelector: string | null
  page: string
}

const FOCUS_RETRY_FRAMES = 12

/**
 * Opening a page focuses its title; going back focuses the row or link you left from,
 * so keyboard and screen-reader users keep their place.
 */
export function useAutomationsPageFocus(
  target: AutomationsPageFocusTarget | null,
  containerRef: React.RefObject<HTMLElement | null>
): void {
  const previousRef = useRef<AutomationsPageFocusTarget | null>(null)
  const key = target?.key ?? null
  useLayoutEffect(() => {
    // Why: resolving states (loading, deep link) have no target; keep the last real page.
    if (!target) {
      return
    }
    const previous = previousRef.current
    previousRef.current = target
    if (!previous || previous.key === target.key) {
      return
    }
    const selector =
      previous.returnSelector && previous.parents.includes(target.page)
        ? previous.returnSelector
        : null
    let frame = 0
    let handle = 0
    const attempt = (): void => {
      const container = containerRef.current
      if (!container) {
        return
      }
      // Why: virtualized rows and freshly opened pages mount a frame or two later.
      const element =
        (selector ? container.querySelector<HTMLElement>(selector) : null) ??
        (selector && frame < FOCUS_RETRY_FRAMES
          ? null
          : container.querySelector<HTMLElement>('[data-automations-page-title]'))
      if (element) {
        element.focus({ preventScroll: false })
        return
      }
      if (frame++ < FOCUS_RETRY_FRAMES) {
        handle = requestAnimationFrame(attempt)
      }
    }
    attempt()
    return () => cancelAnimationFrame(handle)
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- focus follows page identity only.
  }, [key])
}
