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
    if (replayKeyRef.current !== null) {
      // Why: a replay that lands where it asked is already the current entry. One that settles
      // elsewhere (its run history could not be read) records nothing: the entry keeps the
      // requested run, so Back/Forward can try it again, and Forward history is untouched.
      replayKeyRef.current = null
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
  /** That run qualified by its automation row, for tables that list several hosts. */
  returnRunKey?: string
  page: string
}

/** Leave a visible row where it is; bring an off-screen one to the middle of its scroller. */
function revealReturnedRow(element: HTMLElement): void {
  const rect = element.getBoundingClientRect()
  let scroller = element.parentElement
  while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) {
    scroller = scroller.parentElement
  }
  const view = scroller?.getBoundingClientRect() ?? {
    top: 0,
    bottom: window.innerHeight
  }
  const visible = rect.top >= view.top && rect.bottom <= view.bottom
  if (!visible) {
    element.scrollIntoView({ block: 'center' })
  }
}

// A page's title, or on the list and Runs pages (which have none) their named search field.
const PAGE_FOCUS_TARGET = '[data-automations-page-title], [data-automations-page-search]'

const RETURN_HIGHLIGHT_MS = 1500
// How long a returned-to row keeps focus through a list that is still re-rendering.
const RETURN_SETTLE_MS = 1000

/** Briefly tint the row the user returned to, fading out (instantly gone with reduced motion). */
function flashReturnedRow(element: HTMLElement): void {
  if (typeof element.animate !== 'function') {
    return
  }
  // Why: the accent token is close to the hover background; a primary tint reads as a mark.
  const primary = getComputedStyle(element).getPropertyValue('--primary').trim()
  if (!primary) {
    return
  }
  const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
  // Why: an inset shadow paints over any background, so the row and its sticky name cell
  // (which paints its own, transitioning background) get the same tint.
  const tint = `inset 0 0 0 100vmax color-mix(in srgb, ${primary} 14%, transparent)`
  const clear = `inset 0 0 0 100vmax transparent`
  const flash = (target: HTMLElement, pseudoElement?: string): void => {
    target.animate(
      [
        { boxShadow: tint },
        { boxShadow: tint, offset: reduceMotion ? 0.99 : 0.4 },
        { boxShadow: clear }
      ],
      {
        duration: RETURN_HIGHLIGHT_MS,
        easing: reduceMotion ? 'step-end' : 'ease-out',
        pseudoElement
      }
    )
  }
  flash(element)
  for (const cell of element.querySelectorAll<HTMLElement>('*')) {
    if (getComputedStyle(cell).position === 'sticky') {
      // Its edge strips (::before/::after) extend the background past the cell.
      flash(cell)
      flash(cell, '::before')
      flash(cell, '::after')
    }
  }
}

// Virtualized rows mount after a scroll, and a list that reloads on open (Runs) lists the row
// only once its data arrives; past this, focus falls back to the page's own target.
const FOCUS_RETRY_MS = 5000

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
  const returnRunKey = target?.returnRunKey
  useLayoutEffect(() => {
    // Why: resolving states (loading, deep link) have no target; keep the last real page.
    if (key === null || page === null) {
      return
    }
    const previous = previousRef.current
    previousRef.current = {
      key,
      page,
      parents: parents.split(','),
      returnSelector,
      returnRunId,
      returnRunKey
    }
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
    const giveUpAt = performance.now() + FOCUS_RETRY_MS
    const focusedAtStart = document.activeElement
    let handle = 0
    let keepUntil = 0
    // The row this hook focused; any other focus means the user moved on.
    let ownFocus: HTMLElement | null = null
    let yielded = false
    // Why: once the user focuses anything else, this navigation's repair stops for good,
    // even if that focus later returns to the page body.
    const onFocusIn = (event: FocusEvent): void => {
      const target = event.target
      if (!(target instanceof Element) || !selector || !target.matches(selector)) {
        yielded = true
      }
    }
    document.addEventListener('focusin', onFocusIn, true)
    const focusRow = (row: HTMLElement): void => {
      ownFocus = row
      revealReturnedRow(row)
      row.focus({ preventScroll: true })
      flashReturnedRow(row)
    }
    // Why: a list that is still loading (Runs reloads on return) can drop or replace the row
    // just focused, and list it again only when its data arrives; keep it focused for the
    // whole readiness budget while focus has gone nowhere else.
    const keepReturnedFocus = (): void => {
      const container = containerRef.current
      if (!container || !selector || yielded) {
        return
      }
      const active = document.activeElement
      const stillOurs = ownFocus !== null && active === ownFocus && ownFocus.isConnected
      if (!stillOurs) {
        const replacement = container.querySelector<HTMLElement>(selector)
        if (replacement) {
          focusRow(replacement)
        } else if (returning?.returnRunId) {
          requestAutomationRunReveal(returning.returnRunId, returning.returnRunKey)
        }
      }
      if (performance.now() < keepUntil) {
        handle = requestAnimationFrame(keepReturnedFocus)
        return
      }
      // Why: the row never came back (the refetch dropped it); land on the page's own target
      // rather than leaving focus on the body.
      if (!stillOurs && !container.querySelector(selector)) {
        container.querySelector<HTMLElement>(PAGE_FOCUS_TARGET)?.focus({ preventScroll: false })
      }
    }
    const attempt = (): void => {
      const container = containerRef.current
      if (!container) {
        return
      }
      // Why: the user moved on (clicked or typed somewhere) while the row was loading.
      const active = document.activeElement
      if (yielded || (active && active !== focusedAtStart && active !== document.body)) {
        return
      }
      const element =
        (selector ? container.querySelector<HTMLElement>(selector) : null) ??
        (selector && performance.now() < giveUpAt
          ? null
          : container.querySelector<HTMLElement>(PAGE_FOCUS_TARGET))
      if (element) {
        if (selector && element.matches(selector)) {
          // Why: focus set from code after a pointer click draws no ring, so mark the row
          // you came back to; an off-screen row is also brought into view.
          focusRow(element)
          keepUntil = Math.max(giveUpAt, performance.now() + RETURN_SETTLE_MS)
          handle = requestAnimationFrame(keepReturnedFocus)
          return
        }
        element.focus({ preventScroll: false })
        return
      }
      if (returning?.returnRunId) {
        requestAutomationRunReveal(returning.returnRunId, returning.returnRunKey)
      }
      if (performance.now() < giveUpAt + 100) {
        handle = requestAnimationFrame(attempt)
      }
    }
    attempt()
    return () => {
      cancelAnimationFrame(handle)
      document.removeEventListener('focusin', onFocusIn, true)
    }
  }, [key, page, parents, returnSelector, returnRunId, returnRunKey, containerRef])
}
