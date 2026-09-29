import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { MutableRefObject } from 'react'
import { measureUsageRow, pickCollapsedUsageChips } from './status-bar-usage-collapse'

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

// Why: ordered roomiest → tightest so each step gives up the least useful detail first.
// Usage gives way before right-side labels (collapsing into "+N" before those go
// icon-only) because the Usage popover holds everything the bar drops.
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

/** Roomiest level known to fit; an unmeasured level is returned so it gets probed. */
export function pickStatusBarDensityLevel(
  levelWidths: readonly (StatusBarLevelWidth | undefined)[],
  availableWidth: number
): number {
  const tightest = STATUS_BAR_DENSITY_LEVELS.length - 1
  for (let level = 0; level < tightest; level++) {
    const width = levelWidths[level]
    if (width === undefined || width.fit <= availableWidth + WIDTH_TOLERANCE_PX) {
      return level
    }
  }
  return tightest
}

/** A level measuring differently than before means the content changed, so every other level's width is stale. */
export function recordStatusBarDensityWidth(
  levelWidths: readonly (StatusBarLevelWidth | undefined)[],
  level: number,
  width: StatusBarLevelWidth
): (StatusBarLevelWidth | undefined)[] {
  const previous = levelWidths[level]
  const next =
    previous !== undefined && Math.abs(previous.natural - width.natural) > WIDTH_TOLERANCE_PX
      ? []
      : [...levelWidths]
  next[level] = width
  return next
}

type ElementRef = MutableRefObject<HTMLElement | null>

function measureWidth(ref: ElementRef): number {
  return ref.current?.getBoundingClientRect().width ?? 0
}

/**
 * Picks the roomiest density at which the usage cluster and the right-side segments fit
 * on one line. Widths are measured from the rendered content, so a transient segment
 * (update ready, chats to resume) condenses the bar only while it is present. At the
 * collapsing levels it also names the usage chips that give way to a "+N" chip.
 */
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

  const evaluate = useCallback((): void => {
    const bar = barElementRef.current
    if (!bar) {
      return
    }
    const style = getComputedStyle(bar)
    const available =
      bar.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight)
    const usage = measureUsageRow(usageElementRef.current)
    const fixedWidth = (Number.parseFloat(style.columnGap) || 0) + measureWidth(segmentsElementRef)
    const required = usage.naturalWidth + fixedWidth
    const collapses = STATUS_BAR_DENSITY_LEVELS[committedLevelRef.current].collapseUsage
    levelWidthsRef.current = recordStatusBarDensityWidth(
      levelWidthsRef.current,
      committedLevelRef.current,
      { natural: required, fit: collapses ? usage.pinnedWidth + fixedWidth : required }
    )
    const nextLevel = pickStatusBarDensityLevel(levelWidthsRef.current, available)
    if (nextLevel !== committedLevelRef.current) {
      setLevel(nextLevel)
    }
    const collapsible =
      nextLevel === committedLevelRef.current && STATUS_BAR_DENSITY_LEVELS[nextLevel].collapseUsage
    const nextCollapsed = collapsible
      ? pickCollapsedUsageChips(
          usage.chips,
          required - available - WIDTH_TOLERANCE_PX,
          usage.moreChipWidth,
          usage.chipGap
        )
      : NO_COLLAPSED_USAGE
    if (nextCollapsed.join() !== collapsedUsageRef.current.join()) {
      collapsedUsageRef.current = nextCollapsed
      setCollapsedUsageProviders(nextCollapsed)
    }
    const nextOverflowing = usage.renderedWidth + fixedWidth > available + WIDTH_TOLERANCE_PX
    if (nextOverflowing !== overflowingRef.current) {
      overflowingRef.current = nextOverflowing
      setOverflowing(nextOverflowing)
    }
  }, [])

  // Why: runs before paint, so probing a roomier level that turns out not to fit never flashes.
  useLayoutEffect(() => {
    committedLevelRef.current = level
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
