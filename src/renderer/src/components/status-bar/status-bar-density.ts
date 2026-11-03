import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { MutableRefObject } from 'react'
import {
  measureUsageRow,
  pickCollapsedUsageChips,
  resolveUsageChipWidth,
  type UsageChipMeasure,
  type UsageChipWidthMemo
} from './status-bar-usage-collapse'

export type StatusBarDensity = {
  /** Drop usage mini bars and secondary segment labels. */
  compact: boolean
  /** One percentage per provider, whatever the chosen usage mode. */
  usageTightestOnly: boolean
  /** Right-side segments show icon + count; tooltips carry the label. */
  segmentsIconOnly: boolean
  /** Calm providers give way to a "+N" chip when even one percentage each doesn't fit. */
  collapseUsage: boolean
}

// Drop usage detail before other labels because the Usage popover retains everything hidden by density.
export const STATUS_BAR_DENSITY_LEVELS: readonly StatusBarDensity[] = [
  { compact: false, usageTightestOnly: false, segmentsIconOnly: false, collapseUsage: false },
  { compact: true, usageTightestOnly: false, segmentsIconOnly: false, collapseUsage: false },
  { compact: true, usageTightestOnly: true, segmentsIconOnly: false, collapseUsage: false },
  { compact: true, usageTightestOnly: true, segmentsIconOnly: false, collapseUsage: true },
  { compact: true, usageTightestOnly: true, segmentsIconOnly: true, collapseUsage: true }
]

export type StatusBarLevelWidth = {
  /** Width with every usage chip shown; a change here means the content changed. */
  natural: number
  /** Narrowest the level can get: natural, or with calm chips collapsed where the level allows it. */
  fit: number
}
const NO_COLLAPSED_USAGE: readonly string[] = []

const WIDTH_TOLERANCE_PX = 1
const TIGHTEST_LEVEL = STATUS_BAR_DENSITY_LEVELS.length - 1

// Why: backstop for measurement drift we cannot explain; layout-effect updates must never chain into React's update-depth limit (#185).
const MAX_SETTLE_UPDATES = STATUS_BAR_DENSITY_LEVELS.length * 3

/** Room and row content a collapsed set was chosen for; it is kept until either changes. */
type CollapseBasis = { level: number; collapsed: string; available: number; natural: number }

/** Roomiest level known to fit; an unmeasured level is returned so it gets probed. */
export function pickStatusBarDensityLevel(
  levelWidths: readonly (StatusBarLevelWidth | undefined)[],
  availableWidth: number
): number {
  for (let level = 0; level < TIGHTEST_LEVEL; level++) {
    const width = levelWidths[level]
    if (width === undefined || width.fit <= availableWidth + WIDTH_TOLERANCE_PX) {
      return level
    }
  }
  return TIGHTEST_LEVEL
}

/** Natural-width changes invalidate all other levels; fit-only changes invalidate collapsing levels. */
export function recordStatusBarDensityWidth(
  levelWidths: readonly (StatusBarLevelWidth | undefined)[],
  level: number,
  width: StatusBarLevelWidth
): (StatusBarLevelWidth | undefined)[] {
  const previous = levelWidths[level]
  const naturalChanged =
    previous !== undefined && Math.abs(previous.natural - width.natural) > WIDTH_TOLERANCE_PX
  // Why: urgency can change which chips pin without moving the natural width.
  const fitChanged =
    previous !== undefined && Math.abs(previous.fit - width.fit) > WIDTH_TOLERANCE_PX
  const next = naturalChanged
    ? []
    : fitChanged
      ? levelWidths.map((entry, index) =>
          STATUS_BAR_DENSITY_LEVELS[index]?.collapseUsage ? undefined : entry
        )
      : [...levelWidths]
  next[level] = width
  return next
}

type ElementRef = MutableRefObject<HTMLElement | null>

function measureWidth(ref: ElementRef): number {
  return ref.current?.getBoundingClientRect().width ?? 0
}

/** Measure rendered widths to choose the roomiest fitting density and collapse usage chips when needed. */
export function useStatusBarDensity(): {
  density: StatusBarDensity
  overflowing: boolean
  collapsedUsageProviders: readonly string[]
  barRef: (node: HTMLElement | null) => void
  usageRef: (node: HTMLElement | null) => void
  segmentsRef: (node: HTMLElement | null) => void
} {
  const [level, setLevel] = useState(0)
  const [overflowing, setOverflowing] = useState(false)
  const [collapsedUsageProviders, setCollapsedUsageProviders] = useState(NO_COLLAPSED_USAGE)
  const committedLevelRef = useRef(0)
  const overflowingRef = useRef(false)
  const collapsedUsageRef = useRef(NO_COLLAPSED_USAGE)
  const levelWidthsRef = useRef<(StatusBarLevelWidth | undefined)[]>([])
  const barElementRef = useRef<HTMLElement | null>(null)
  const usageElementRef = useRef<HTMLElement | null>(null)
  const segmentsElementRef = useRef<HTMLElement | null>(null)
  const observerRef = useRef<ResizeObserver | null>(null)
  const chipWidthsRef = useRef({ key: '', widths: new Map<string, UsageChipWidthMemo>() })
  const collapseBasisRef = useRef<CollapseBasis | null>(null)
  const settleUpdatesRef = useRef(0)
  const settleExhaustedRef = useRef(false)
  const settlingRef = useRef(false)
  const settleAvailableRef = useRef(Number.NaN)

  const resetSettlePass = useCallback((): void => {
    settleUpdatesRef.current = 0
    settleExhaustedRef.current = false
  }, [])

  const applyCollapsed = useCallback((next: readonly string[]): void => {
    collapsedUsageRef.current = next
    setCollapsedUsageProviders(next)
  }, [])

  const applyOverflowing = useCallback((next: boolean): void => {
    overflowingRef.current = next
    setOverflowing(next)
  }, [])

  /**
   * Last resort when measurements keep drifting: stop on the tightest level with every calm chip
   * collapsed. The bar stays there until the next resize or a render this hook did not cause.
   */
  const settleOnTightestState = useCallback(
    (chips: readonly UsageChipMeasure[], nextOverflowing: boolean): void => {
      if (!settleExhaustedRef.current) {
        settleExhaustedRef.current = true
        console.warn(
          `[status-bar] density did not settle within ${MAX_SETTLE_UPDATES} updates; using the tightest layout`
        )
        const calm = chips.filter((chip) => !chip.urgent).map((chip) => chip.provider)
        if (committedLevelRef.current !== TIGHTEST_LEVEL) {
          settlingRef.current = true
          setLevel(TIGHTEST_LEVEL)
        }
        if (calm.join() !== collapsedUsageRef.current.join()) {
          settlingRef.current = true
          applyCollapsed(calm)
        }
        return
      }
      // Overflow only styles the clip edge, so one more sync after the fallback cannot feed back into measurements.
      if (
        nextOverflowing !== overflowingRef.current &&
        settleUpdatesRef.current <= MAX_SETTLE_UPDATES
      ) {
        settleUpdatesRef.current += 1
        settlingRef.current = true
        applyOverflowing(nextOverflowing)
      }
    },
    [applyCollapsed, applyOverflowing]
  )

  const evaluate = useCallback((): void => {
    const bar = barElementRef.current
    if (!bar) {
      return
    }
    const style = getComputedStyle(bar)
    const available =
      bar.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight)
    const level = committedLevelRef.current
    // Why: chip content (compact) and pixel snapping change with density and DPR, so remembered widths only hold within both.
    const chipWidthsKey = `${level}@${window.devicePixelRatio}`
    if (chipWidthsRef.current.key !== chipWidthsKey) {
      chipWidthsRef.current = { key: chipWidthsKey, widths: new Map() }
    }
    const chipWidths = chipWidthsRef.current.widths
    const usage = measureUsageRow(usageElementRef.current, (provider, measured, collapsed) =>
      resolveUsageChipWidth(chipWidths, provider, measured, collapsed)
    )
    const fixedWidth = (Number.parseFloat(style.columnGap) || 0) + measureWidth(segmentsElementRef)
    const required = usage.naturalWidth + fixedWidth
    const collapses = STATUS_BAR_DENSITY_LEVELS[level].collapseUsage
    levelWidthsRef.current = recordStatusBarDensityWidth(levelWidthsRef.current, level, {
      natural: required,
      fit: collapses ? usage.pinnedWidth + fixedWidth : required
    })
    const nextLevel = pickStatusBarDensityLevel(levelWidthsRef.current, available)
    const nextOverflowing = usage.renderedWidth + fixedWidth > available + WIDTH_TOLERANCE_PX
    const currentCollapsed = collapsedUsageRef.current
    const basis = collapseBasisRef.current
    // Why: a collapsed set that fits is kept until the room or the row's content changes, so it cannot flip-flop at a fixed level.
    const keepCollapsed =
      currentCollapsed.length > 0 &&
      !nextOverflowing &&
      basis !== null &&
      basis.level === level &&
      basis.collapsed === currentCollapsed.join() &&
      basis.available === available &&
      Math.abs(basis.natural - required) <= WIDTH_TOLERANCE_PX
    const collapsible = nextLevel === level && STATUS_BAR_DENSITY_LEVELS[nextLevel].collapseUsage
    const nextCollapsed = !collapsible
      ? NO_COLLAPSED_USAGE
      : keepCollapsed
        ? currentCollapsed
        : pickCollapsedUsageChips(
            usage.chips,
            required - available - WIDTH_TOLERANCE_PX,
            usage.moreChipWidth,
            usage.chipGap,
            usage.unitLabelWidth
          )
    collapseBasisRef.current =
      nextCollapsed.length > 0
        ? { level, collapsed: nextCollapsed.join(), available, natural: required }
        : null

    if (available !== settleAvailableRef.current) {
      settleAvailableRef.current = available
      resetSettlePass()
    }
    const levelChanged = nextLevel !== level
    const collapsedChanged = nextCollapsed.join() !== currentCollapsed.join()
    const overflowingChanged = nextOverflowing !== overflowingRef.current
    if (!levelChanged && !collapsedChanged && !overflowingChanged) {
      resetSettlePass()
      return
    }
    if (settleUpdatesRef.current >= MAX_SETTLE_UPDATES) {
      settleOnTightestState(usage.chips, nextOverflowing)
      return
    }
    settleUpdatesRef.current += 1
    settlingRef.current = true
    if (levelChanged) {
      setLevel(nextLevel)
    }
    if (collapsedChanged) {
      applyCollapsed(nextCollapsed)
    }
    if (overflowingChanged) {
      applyOverflowing(nextOverflowing)
    }
  }, [applyCollapsed, applyOverflowing, resetSettlePass, settleOnTightestState])

  // Why: runs before paint, so probing a roomier level that turns out not to fit never flashes.
  useLayoutEffect(() => {
    committedLevelRef.current = level
    // Only renders this hook caused continue a settle pass; any other render starts a fresh one.
    if (!settlingRef.current) {
      resetSettlePass()
    }
    settlingRef.current = false
    evaluate()
  })

  useEffect(() => () => observerRef.current?.disconnect(), [])

  const refs = useMemo(() => {
    const bind =
      (target: ElementRef) =>
      (node: HTMLElement | null): void => {
        observerRef.current ??= new ResizeObserver(() => evaluate())
        if (target.current) {
          observerRef.current.unobserve(target.current)
        }
        target.current = node
        if (node) {
          observerRef.current.observe(node)
        }
      }
    return {
      barRef: bind(barElementRef),
      usageRef: bind(usageElementRef),
      segmentsRef: bind(segmentsElementRef)
    }
  }, [evaluate])

  return {
    density: STATUS_BAR_DENSITY_LEVELS[level],
    overflowing,
    collapsedUsageProviders,
    ...refs
  }
}
