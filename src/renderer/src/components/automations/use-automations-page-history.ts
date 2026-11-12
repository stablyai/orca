import { useEffect, useLayoutEffect, useRef } from 'react'
import { useAppStore } from '@/store/index'
import { automationsPageLocationKey } from '../../store/slices/ui/automations-page-location'
import type { AutomationsPageLocation } from './automation-page-state'
import type { AutomationsPageNavigation } from './automations-page-navigation'
import { requestAutomationRunReveal } from './runs/automations-reveal-run'

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

  const key = location ? automationsPageLocationKey(location) : null
  const keyRef = useRef(key)
  const locationRef = useRef(location)
  const requestRef = useRef(request)
  const goToLocationRef = useRef(navigation.goToLocation)
  // The key of the entry a Back/Forward replay is showing, until the page settles.
  const replayKeyRef = useRef<string | null>(null)
  useEffect(() => {
    keyRef.current = key
    locationRef.current = location
    requestRef.current = request
    goToLocationRef.current = navigation.goToLocation
  })
  useEffect(() => {
    if (!request) {
      return
    }
    setRequest(null)
    const requestKey = automationsPageLocationKey(request)
    // Why: a replay of the page already shown changes nothing, so nothing will settle.
    replayKeyRef.current = requestKey === keyRef.current ? null : requestKey
    goToLocationRef.current(request)
  }, [request, setRequest])

  useEffect(() => {
    // Why: record only when the page itself changes. Clearing a replay request can render
    // once before the page state it asked for, still showing the page Back just left;
    // re-running on the request change would record that page and cut Forward history.
    if (key === null || requestRef.current || !locationRef.current) {
      return
    }
    const replayKey = replayKeyRef.current
    if (replayKey !== null) {
      replayKeyRef.current = null
      // A replay that lands where it asked is already the current entry. One that settles
      // elsewhere (its run history could not be read) swaps that entry, keeping Forward.
      if (key !== replayKey) {
        record(locationRef.current, 'replace')
      }
      return
    }
    record(locationRef.current)
  }, [key, record])
}

export type AutomationsPageFocusTarget = {
  /** Changes whenever the visible sub-page changes. */
  key: string
  /** Pages this one is a child of; returning to one restores focus to `returnSelector`. */
  parents: readonly string[]
  /** This page's entry in its parent (its list row, rail item, or "All runs" link). */
  returnSelector: string | null
  /** Set when that entry is a run row, which a virtualized table may need to scroll to. */
  returnRunId?: string
  page: string
}

// Virtualized rows mount after a scroll, and a freshly opened page a frame or two later.
const FOCUS_RETRY_FRAMES = 30

/**
 * Opening a page focuses its title; going back focuses the row or link you left from,
 * so keyboard and screen-reader users keep their place. A page that appears without a
 * user action (restored at launch or on reload) leaves focus alone.
 */
export function useAutomationsPageFocus(
  target: AutomationsPageFocusTarget | null,
  containerRef: React.RefObject<HTMLElement | null>
): void {
  const previousRef = useRef<AutomationsPageFocusTarget | null>(null)
  const key = target?.key ?? null
  const page = target?.page ?? null
  const parents = target?.parents.join(',') ?? ''
  const returnSelector = target?.returnSelector ?? null
  const returnRunId = target?.returnRunId
  useLayoutEffect(() => {
    // Why: resolving states (loading, deep link) have no target; keep the last real page.
    if (key === null || page === null) {
      return
    }
    const previous = previousRef.current
    previousRef.current = { key, page, parents: parents.split(','), returnSelector, returnRunId }
    const store = useAppStore.getState()
    const userOpened = store.automationsPageFocusTitleOnOpen
    if (userOpened) {
      store.setAutomationsPageFocusTitleOnOpen(false)
    }
    if (previous ? previous.key === key : !userOpened) {
      return
    }
    const returning = previous?.returnSelector && previous.parents.includes(page) ? previous : null
    const selector = returning?.returnSelector ?? null
    let frame = 0
    let handle = 0
    const attempt = (): void => {
      const container = containerRef.current
      if (!container) {
        return
      }
      const element =
        (selector ? container.querySelector<HTMLElement>(selector) : null) ??
        (selector && frame < FOCUS_RETRY_FRAMES
          ? null
          : container.querySelector<HTMLElement>('[data-automations-page-title]'))
      if (element) {
        element.focus({ preventScroll: false })
        return
      }
      if (returning?.returnRunId) {
        requestAutomationRunReveal(returning.returnRunId)
      }
      frame += 1
      if (frame <= FOCUS_RETRY_FRAMES) {
        handle = requestAnimationFrame(attempt)
      }
    }
    attempt()
    return () => cancelAnimationFrame(handle)
  }, [key, page, parents, returnSelector, returnRunId, containerRef])
}
