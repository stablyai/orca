import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  planTabStrip,
  sameTabStripMembership,
  TITLED_TAB_STRIP_PLAN,
  type TabStripPlan
} from './tab-strip-condense-plan'
import { TITLED_TAB_STRIP_DENSITY, type TabStripDensity } from './tab-strip-density-context'
import { TAB_ICON_ONLY_WIDTH_PX } from './tab-strip-width-budget'

// The strip's own border-r sits inside the surface beside the tabs.
const STRIP_BORDER_PX = 1
// A close must follow its pointerdown closely for the widths captured there to still apply.
const HOLD_SNAPSHOT_MAX_AGE_MS = 1500

export type TabStripCondense = {
  plan: TabStripPlan
  hiddenIds: ReadonlySet<string>
  density: TabStripDensity
  /** Scroll arrows only for a rename's 300px slot: a plan always fits, and arrows that appear on a
   * transient overflow would squeeze the strip and keep it overflowing. */
  showScrollArrows: boolean
  surface: HTMLDivElement | null
  setSurface: (node: HTMLDivElement | null) => void
  stripPointerHandlers: {
    onPointerDownCapture: () => void
    onPointerEnter: () => void
    onPointerLeave: () => void
  }
}

const NO_HIDDEN: ReadonlySet<string> = new Set()

/**
 * Room for tabs: the surface minus "+" and the strip border; the chip is planned in. Scroll arrows
 * are left out: they appear only while content overflows, which a plan from this width prevents,
 * so counting a transient arrow would shrink the plan and never re-measure.
 */
function measureTabRoom(surface: HTMLElement): number {
  let width = surface.clientWidth - STRIP_BORDER_PX
  for (const reserve of surface.querySelectorAll<HTMLElement>('[data-tab-strip-reserve]')) {
    if (reserve.offsetWidth === 0) {
      continue
    }
    const style = getComputedStyle(reserve)
    width -=
      reserve.offsetWidth +
      (Number.parseFloat(style.marginLeft) || 0) +
      (Number.parseFloat(style.marginRight) || 0)
  }
  return Math.max(0, Math.floor(width))
}

function measureSlotWidths(surface: HTMLElement): Map<string, number> {
  const widths = new Map<string, number>()
  for (const slot of surface.querySelectorAll<HTMLElement>('[data-tab-strip-slot]')) {
    widths.set(slot.dataset.tabStripSlot!, slot.getBoundingClientRect().width)
  }
  return widths
}

const renameWatchers = new WeakMap<HTMLElement, MutationObserver>()

/** Watches only while a rename is open: a re-plan skipped for the rename runs when its input leaves. */
function watchRenameEnd(surface: HTMLElement, replanRef: { current: () => void }): void {
  if (renameWatchers.has(surface)) {
    return
  }
  const observer = new MutationObserver(() => {
    if (!surface.isConnected || !surface.querySelector('[data-tab-rename-input]')) {
      observer.disconnect()
      renameWatchers.delete(surface)
      if (surface.isConnected) {
        replanRef.current()
      }
    }
  })
  observer.observe(surface, { childList: true, subtree: true })
  renameWatchers.set(surface, observer)
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index])
}

/** Drop ids that no longer exist; ids the plan has never seen stay hidden until the next plan. */
function reconcilePlan(plan: TabStripPlan, ids: readonly string[]): TabStripPlan {
  if (plan.mode === 'titled') {
    return plan
  }
  const present = new Set(ids)
  const iconIds = plan.iconIds.filter((id) => present.has(id))
  const shown = new Set(plan.chipOnly ? [] : [plan.activeId, ...iconIds])
  const hiddenIds = ids.filter((id) => !shown.has(id))
  if (sameIds(iconIds, plan.iconIds) && sameIds(hiddenIds, plan.hiddenIds)) {
    return plan
  }
  return { ...plan, iconIds, hiddenIds }
}

export function useTabStripCondense({
  ids,
  activeId,
  frozen,
  hasOverflow,
  disabled = false
}: {
  /** Strip entries in order: unified tabs, then paired-client rows. */
  ids: readonly string[]
  activeId: string | null
  /** Hold membership while a tab drag would otherwise reshuffle tabs under the pointer. */
  frozen: boolean
  hasOverflow: boolean
  /** Fit mode uses horizontal scrolling instead of condensing tabs into icons or a "+N" chip. */
  disabled?: boolean
}): TabStripCondense {
  const [surface, setSurface] = useState<HTMLDivElement | null>(null)
  const [plan, setPlan] = useState<TabStripPlan>(TITLED_TAB_STRIP_PLAN)
  const [heldWidths, setHeldWidths] = useState<ReadonlyMap<string, number> | null>(null)
  // The icon slots captured with the held widths: a re-plan during the hold must not retitle them.
  const [heldIconIds, setHeldIconIds] = useState<ReadonlySet<string>>(NO_HIDDEN)
  const planRef = useRef(plan)
  const windowStartRef = useRef<number | null>(null)
  const inputsRef = useRef({ ids, activeId, frozen, heldWidths, heldIconIds, disabled })
  // Declared before the effects that read it, so they see this render's inputs.
  useLayoutEffect(() => {
    inputsRef.current = { ids, activeId, frozen, heldWidths, heldIconIds, disabled }
  })

  const replanRef = useRef<() => void>(() => {})
  const replan = useCallback(() => {
    if (!surface) {
      return
    }
    const {
      ids: currentIds,
      activeId: currentActive,
      frozen: isFrozen,
      heldWidths: held,
      disabled: isDisabled
    } = inputsRef.current
    if (isDisabled) {
      windowStartRef.current = null
      if (planRef.current.mode !== 'titled') {
        planRef.current = TITLED_TAB_STRIP_PLAN
        setPlan(TITLED_TAB_STRIP_PLAN)
      }
      if (held) {
        setHeldWidths(null)
      }
      return
    }
    const width = measureTabRoom(surface)
    if (held) {
      let total = 0
      for (const value of held.values()) {
        total += value
      }
      if (total > width) {
        setHeldWidths(null)
      }
      return
    }
    if (isFrozen) {
      return
    }
    // A rename keeps its 300px slot and scrolls; re-planning would unmount the row being edited.
    // Replan once the input leaves, since a resize during the rename was skipped.
    if (surface.querySelector('[data-tab-rename-input]')) {
      watchRenameEnd(surface, replanRef)
      return
    }
    const next = planTabStrip({
      width,
      ids: currentIds,
      activeId: currentActive,
      previousWindowStart: windowStartRef.current
    })
    if (next.mode === 'condensed') {
      surface.style.setProperty('--tab-strip-active-width', `${next.activeWidth}px`)
    }
    windowStartRef.current =
      next.mode === 'condensed' && next.hiddenIds.length > 0 ? next.windowStart : null
    if (!sameTabStripMembership(planRef.current, next)) {
      planRef.current = next
      setPlan(next)
    }
  }, [surface])

  useLayoutEffect(() => {
    replanRef.current = replan
  }, [replan])

  useLayoutEffect(() => {
    if (!surface) {
      return undefined
    }
    const observer = new ResizeObserver(replan)
    observer.observe(surface)
    return () => observer.disconnect()
  }, [surface, replan])

  const idsKey = ids.join('\u0000')
  useLayoutEffect(() => {
    replan()
  }, [replan, idsKey, activeId, frozen, heldWidths, disabled])

  // Hold widths so the next close button stays under the pointer.
  const pointerInsideRef = useRef(false)
  const snapshotRef = useRef<{
    widths: Map<string, number>
    iconIds: ReadonlySet<string>
    ids: string
    at: number
  } | null>(null)
  const previousRef = useRef({ idsKey, ids, activeId })
  useLayoutEffect(() => {
    const previous = previousRef.current
    previousRef.current = { idsKey, ids, activeId }
    if (previous.idsKey === idsKey) {
      if (previous.activeId !== activeId) {
        setHeldWidths(null)
      }
      return
    }
    const snapshot = snapshotRef.current
    if (
      ids.length >= previous.ids.length ||
      !pointerInsideRef.current ||
      !snapshot ||
      snapshot.ids !== previous.idsKey ||
      performance.now() - snapshot.at > HOLD_SNAPSHOT_MAX_AGE_MS
    ) {
      setHeldWidths(null)
      return
    }
    const previousIds = new Set(previous.ids)
    if (!ids.every((id) => previousIds.has(id))) {
      setHeldWidths(null)
      return
    }
    const present = new Set(ids)
    const held = new Map([...snapshot.widths].filter(([id]) => present.has(id)))
    const activeHeld = activeId === null ? undefined : held.get(activeId)
    // An icon that just became active needs its title, so the strip reflows instead.
    const keep =
      held.size === ids.length && activeHeld !== undefined && activeHeld > TAB_ICON_ONLY_WIDTH_PX
    setHeldIconIds(
      keep ? new Set([...snapshot.iconIds].filter((id) => present.has(id))) : NO_HIDDEN
    )
    setHeldWidths(keep ? held : null)
  }, [idsKey, ids, activeId])

  const [renameOverflow, setRenameOverflow] = useState(false)
  useLayoutEffect(() => {
    setRenameOverflow(hasOverflow && !!surface?.querySelector('[data-tab-rename-input]'))
  }, [hasOverflow, surface])

  const effectivePlan = useMemo(
    () => (disabled ? TITLED_TAB_STRIP_PLAN : reconcilePlan(plan, ids)),
    [disabled, plan, ids]
  )
  const hiddenIds = useMemo(
    () => (effectivePlan.mode === 'condensed' ? new Set(effectivePlan.hiddenIds) : NO_HIDDEN),
    [effectivePlan]
  )
  const density = useMemo<TabStripDensity>(() => {
    if (disabled || (effectivePlan.mode === 'titled' && !heldWidths)) {
      return TITLED_TAB_STRIP_DENSITY
    }
    return {
      condensed: effectivePlan.mode === 'condensed',
      iconIds: heldWidths
        ? heldIconIds
        : new Set(effectivePlan.mode === 'condensed' ? effectivePlan.iconIds : []),
      heldWidths
    }
  }, [disabled, effectivePlan, heldWidths, heldIconIds])

  const stripPointerHandlers = useMemo(
    () => ({
      onPointerDownCapture: () => {
        const {
          ids: currentIds,
          heldWidths: held,
          heldIconIds: heldIcons,
          disabled: isDisabled
        } = inputsRef.current
        // Hidden tabs have no width to hold; only a fully visible strip keeps its geometry.
        if (
          !surface ||
          isDisabled ||
          (planRef.current.mode === 'condensed' && planRef.current.hiddenIds.length > 0)
        ) {
          snapshotRef.current = null
          return
        }
        snapshotRef.current = {
          widths: measureSlotWidths(surface),
          // A close during a hold must keep the held icons, not the re-planned (titled) plan's.
          iconIds: held
            ? heldIcons
            : new Set(planRef.current.mode === 'condensed' ? planRef.current.iconIds : []),
          ids: currentIds.join('\u0000'),
          at: performance.now()
        }
      },
      onPointerEnter: () => {
        pointerInsideRef.current = true
      },
      onPointerLeave: () => {
        pointerInsideRef.current = false
        snapshotRef.current = null
        setHeldWidths(null)
      }
    }),
    [surface]
  )

  return {
    plan: effectivePlan,
    hiddenIds,
    density,
    showScrollArrows: disabled ? hasOverflow : renameOverflow,
    surface,
    setSurface,
    stripPointerHandlers
  }
}
