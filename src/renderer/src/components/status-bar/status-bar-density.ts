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
          usage.chipGap,
          usage.unitLabelWidth
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
