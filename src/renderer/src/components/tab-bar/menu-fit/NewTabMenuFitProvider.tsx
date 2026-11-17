import React, { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react'
import {
  AgentPickerListFitContext,
  type AgentPickerListFit
} from '@/components/agent/AgentPickerResultsScroller'
import { NewTabMenuTipRoomContext, type NewTabMenuTipRoom } from './new-tab-menu-tip-room'
import {
  NEW_TAB_MENU_LIST_MAX_ROWS,
  fadeScrollPadding,
  planNewTabMenuFit,
  sameNewTabMenuFitPlan,
  tipFootprintAt,
  type TipFootprint,
  type NewTabMenuFitMode,
  type NewTabMenuFitPlan
} from './new-tab-menu-fit-plan'

const FALLBACK_ROW = 36

type FitLayout = { plan: NewTabMenuFitPlan; row: number }

function sameLayout(a: FitLayout | null, b: FitLayout): boolean {
  return a !== null && a.row === b.row && sameNewTabMenuFitPlan(a.plan, b.plan)
}

function hasMoreBelow(scroller: HTMLElement): boolean {
  return scroller.scrollTop + scroller.clientHeight < scroller.scrollHeight - 1
}

function verticalFrame(element: HTMLElement): number {
  const style = getComputedStyle(element)
  return (
    Number.parseFloat(style.paddingTop) +
    Number.parseFloat(style.paddingBottom) +
    Number.parseFloat(style.borderTopWidth) +
    Number.parseFloat(style.borderBottomWidth)
  )
}

/** The list scrolls in peek mode, the whole menu content in menu mode. */
function scrollerFor(
  mode: NewTabMenuFitMode | null,
  box: HTMLElement | null,
  list: HTMLElement | null
): HTMLElement | null {
  return mode === 'peek' ? list : mode === 'menu' ? (box?.parentElement ?? null) : null
}

/**
 * Lives inside the + menu's content, so it mounts on open and unmounts on the real close:
 * everything it learns (tip height, placed side) lasts one menu session.
 */
export function NewTabMenuFitProvider({
  onPlacedSide,
  children
}: {
  /** The side Radix first placed the menu on; null once the session ends. Must be stable. */
  onPlacedSide: (side: string | null) => void
  children: React.ReactNode
}): React.JSX.Element {
  const [box, setBox] = useState<HTMLDivElement | null>(null)
  const [list, setList] = useState<HTMLDivElement | null>(null)
  const [tip, setTip] = useState<HTMLElement | null>(null)
  const [tipEligible, setTipEligible] = useState(false)
  const [layout, setLayout] = useState<FitLayout | null>(null)
  const [fadeVisible, setFadeVisible] = useState(false)
  // Kept while the tip is yielded or a search unmounts it, so hiding it can't change the plan;
  // dropped when the menu width changes, since the tip wraps differently there.
  const tipFootprint = useRef<TipFootprint | null>(null)
  const placedSide = useRef<string | null>(null)
  const mode = layout?.plan.mode ?? null

  const measure = useEffectEvent(() => {
    const content = box?.parentElement
    const wrapper = content?.parentElement
    if (!box || !content || !wrapper) {
      return
    }
    if (placedSide.current === null && !wrapper.style.transform.includes('-200%')) {
      placedSide.current = content.dataset.side ?? 'bottom'
      onPlacedSide(placedSide.current)
    }
    let planMode = mode
    const available = Number.parseFloat(
      wrapper.style.getPropertyValue('--radix-popper-available-height')
    )
    if (list && Number.isFinite(available)) {
      const tipMounted = tip?.isConnected ? tip : null
      // Outer width: a scrollbar the tip itself causes must not count as a width change.
      const width = content.offsetWidth
      if (tipMounted) {
        // The slot is a flow-root box, so its height includes the tip's own margin.
        tipFootprint.current = { height: tipMounted.offsetHeight, width }
      }
      const footprint = tipFootprintAt(tipFootprint.current, width)
      if (footprint === null) {
        tipFootprint.current = null
      }
      const row = list.querySelector<HTMLElement>('[role="menuitem"]')?.offsetHeight || FALLBACK_ROW
      const chrome =
        box.offsetHeight +
        verticalFrame(content) -
        list.offsetHeight -
        (tipMounted ? tipMounted.offsetHeight : 0)
      const next: FitLayout = {
        row,
        plan: planNewTabMenuFit({
          // Why floor and -1: offsetHeight rounds, and a 1px overshoot would make the menu scroll too.
          available: Math.floor(available) - 1,
          chrome,
          tip: tipEligible ? (footprint ?? 0) : 0,
          natural: list.scrollHeight,
          row
        })
      }
      planMode = next.plan.mode
      setLayout((current) => (sameLayout(current, next) ? current : next))
    }
    // Content can grow or shrink without a scroll event, so the fade is re-checked on every pass.
    const scroller = scrollerFor(planMode, box, list)
    const more = scroller ? hasMoreBelow(scroller) : false
    setFadeVisible((current) => (current === more ? current : more))
  })

  // Observers follow the nodes' real lifetime: the list and tip unmount while a search shows results.
  useEffect(() => {
    const wrapper = box?.parentElement?.parentElement
    if (!box || !wrapper) {
      return
    }
    let frame: number | null = null
    const schedule = (): void => {
      if (frame === null) {
        frame = requestAnimationFrame(() => {
          frame = null
          measure()
        })
      }
    }
    const resize = new ResizeObserver(schedule)
    for (const node of [box, list, list?.firstElementChild, tip]) {
      if (node) {
        resize.observe(node)
      }
    }
    // Radix rewrites the wrapper style only when it repositions (resize, flip).
    const reposition = new MutationObserver(schedule)
    reposition.observe(wrapper, { attributes: true, attributeFilter: ['style'] })
    schedule()
    return () => {
      resize.disconnect()
      reposition.disconnect()
      if (frame !== null) {
        cancelAnimationFrame(frame)
      }
    }
  }, [box, list, tip])

  useEffect(() => {
    // A tip that is gone for good (kept, dismissed, hidden, customized away) frees its room.
    if (!tipEligible) {
      tipFootprint.current = null
    }
    measure()
  }, [tipEligible])

  useEffect(() => {
    const scroller = scrollerFor(mode, box, list)
    if (!scroller) {
      return
    }
    const onScroll = (): void => {
      const more = hasMoreBelow(scroller)
      setFadeVisible((current) => (current === more ? current : more))
    }
    scroller.addEventListener('scroll', onScroll, { passive: true })
    return () => scroller.removeEventListener('scroll', onScroll)
  }, [mode, box, list])

  useEffect(() => () => onPlacedSide(null), [onPlacedSide])

  const listFit = useMemo<AgentPickerListFit>(
    () => ({
      registerList: setList,
      maxHeight: layout ? layout.plan.listMaxHeight : NEW_TAB_MENU_LIST_MAX_ROWS * FALLBACK_ROW,
      scrollPaddingBottom: layout?.plan.mode === 'peek' ? fadeScrollPadding(layout.row) : null,
      fadeVisible: layout?.plan.mode === 'peek' && fadeVisible
    }),
    [layout, fadeVisible]
  )
  const tipHidden = layout?.plan.tipHidden ?? false
  const tipRoom = useMemo<NewTabMenuTipRoom>(
    () => ({ tipHidden, registerTip: setTip, reportTipEligible: setTipEligible }),
    [tipHidden]
  )

  return (
    <div ref={setBox} className="flow-root" data-new-tab-menu-fit={mode ?? undefined}>
      <NewTabMenuTipRoomContext value={tipRoom}>
        <AgentPickerListFitContext value={listFit}>{children}</AgentPickerListFitContext>
      </NewTabMenuTipRoomContext>
      {mode === 'menu' && fadeVisible ? (
        <div
          aria-hidden
          // Why -bottom-1: cover the content's 4px bottom padding, which rows also scroll through.
          className="pointer-events-none sticky -bottom-1 -mt-4 h-4 bg-linear-to-b from-transparent to-popover"
        />
      ) : null}
    </div>
  )
}
