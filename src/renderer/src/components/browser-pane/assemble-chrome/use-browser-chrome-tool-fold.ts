import { useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { BROWSER_CHROME_ADDRESS_SLOT_ATTRIBUTE } from './browser-chrome-address-slot'

/**
 * One step of toolbar compaction. Steps apply in this order as the row narrows, so the least-used
 * tools leave first and the page tools the chrome exists for (grab, annotate) leave last.
 */
export type BrowserChromeFoldStage =
  | 'import-label'
  | 'external'
  | 'devtools'
  | 'share'
  | 'import'
  | 'draw'
  | 'grab'
  | 'annotate'

export const BROWSER_CHROME_FOLD_ORDER: readonly BrowserChromeFoldStage[] = [
  'import-label',
  'external',
  'devtools',
  'share',
  'import',
  'draw',
  'grab',
  'annotate'
]

/** Below this the URL stops being readable, so tools fold before the address shrinks further. */
export const BROWSER_CHROME_ADDRESS_MIN_WIDTH_PX = 120

type RowMeasure = { address: number; overflow: number }

function measureRow(row: HTMLElement | null): RowMeasure | null {
  const slot = row?.querySelector(`[${BROWSER_CHROME_ADDRESS_SLOT_ATTRIBUTE}]`)
  // Why: a hidden pane measures zero; folding everything there would flash on reveal.
  if (!row || !slot || row.clientWidth === 0) {
    return null
  }
  return {
    address: slot.getBoundingClientRect().width,
    overflow: Math.max(0, row.scrollWidth - row.clientWidth)
  }
}

/**
 * Folds `stages` one at a time until the address slot keeps its minimum width and the row stops
 * overflowing, and unfolds as room returns.
 *
 * Why record the width each fold freed instead of re-measuring from zero on every resize: resetting
 * would re-render the toolbar once per stage per resize frame. A fold is undone only when the
 * address has that much slack, so an unfold can never immediately re-trigger its own fold.
 */
export function useBrowserChromeToolFold(
  rowRef: RefObject<HTMLElement | null>,
  stages: readonly BrowserChromeFoldStage[]
): ReadonlySet<BrowserChromeFoldStage> {
  const stagesKey = stages.join(',')
  const [foldedCount, setFoldedCount] = useState(0)
  const level = Math.min(foldedCount, stages.length)
  const freedRef = useRef<{ stagesKey: string; widths: number[] }>({ stagesKey, widths: [] })
  const pendingRef = useRef<(RowMeasure & { level: number }) | null>(null)

  const checkRef = useRef<() => void>(() => {})
  checkRef.current = () => {
    if (freedRef.current.stagesKey !== stagesKey) {
      freedRef.current = { stagesKey, widths: [] }
      pendingRef.current = null
    }
    const measure = measureRow(rowRef.current)
    if (!measure) {
      return
    }
    const freed = freedRef.current.widths
    const pending = pendingRef.current
    if (pending && pending.level === level) {
      freed[level - 1] = measure.address - pending.address + (pending.overflow - measure.overflow)
      pendingRef.current = null
    }
    const shortfall =
      Math.max(0, BROWSER_CHROME_ADDRESS_MIN_WIDTH_PX - measure.address) + measure.overflow
    if (shortfall > 0.5 && level < stages.length) {
      pendingRef.current = { ...measure, level: level + 1 }
      setFoldedCount(level + 1)
      return
    }
    const slack = measure.address - BROWSER_CHROME_ADDRESS_MIN_WIDTH_PX
    if (shortfall <= 0.5 && level > 0 && slack >= (freed[level - 1] ?? 0)) {
      setFoldedCount(level - 1)
    }
  }

  // Why layout effect: each fold step re-measures before paint, so a squeeze never flashes clipped.
  useLayoutEffect(() => {
    checkRef.current()
  }, [level, stagesKey])

  useLayoutEffect(() => {
    const row = rowRef.current
    const slot = row?.querySelector(`[${BROWSER_CHROME_ADDRESS_SLOT_ATTRIBUTE}]`)
    if (!row || typeof ResizeObserver === 'undefined') {
      return
    }
    // Why both: the slot resizes when a sibling tool appears or hides, but stops resizing once it
    // hits zero while the row keeps overflowing.
    const observer = new ResizeObserver(() => checkRef.current())
    observer.observe(row)
    if (slot) {
      observer.observe(slot)
    }
    return () => observer.disconnect()
  }, [rowRef])

  return new Set(stages.slice(0, level))
}
