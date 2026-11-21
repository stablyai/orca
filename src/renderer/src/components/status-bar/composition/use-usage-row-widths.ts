import { useLayoutEffect, useState, type RefCallback } from 'react'
import type { UsageRowWidths } from './status-bar-usage-collapse'

function widthOf(element: Element | null): number {
  return element?.getBoundingClientRect().width ?? 0
}

function horizontalChrome(element: Element | null): number {
  if (!element) {
    return 0
  }
  const style = getComputedStyle(element)
  return (
    (Number.parseFloat(style.paddingLeft) || 0) +
    (Number.parseFloat(style.paddingRight) || 0) +
    (Number.parseFloat(style.borderLeftWidth) || 0) +
    (Number.parseFloat(style.borderRightWidth) || 0)
  )
}

/** Reads only the area's width, constant chrome and the hidden measuring row: never what the layout choice renders. */
export function readUsageRowWidths(area: HTMLElement): UsageRowWidths {
  const trigger = area.querySelector('[data-usage-trigger]')
  const refresh = area.querySelector('[data-usage-refresh]')
  const row = area.querySelector('[data-usage-row]')
  const rowGap = row ? Number.parseFloat(getComputedStyle(row).columnGap) || 0 : 0
  const chipGap = trigger ? Number.parseFloat(getComputedStyle(trigger).columnGap) || 0 : 0
  const chips: Record<string, [number, number, number]> = {}
  for (const element of area.querySelectorAll<HTMLElement>('[data-measure-chip]')) {
    const provider = element.dataset.measureChip ?? ''
    const level = Number(element.dataset.measureLevel)
    const widths = chips[provider] ?? [0, 0, 0]
    chips[provider] = widths
    if (level === 0 || level === 1 || level === 2) {
      widths[level] = widthOf(element)
    }
  }
  return {
    available:
      widthOf(area) - horizontalChrome(trigger) - (refresh ? widthOf(refresh) + rowGap : 0),
    chipGap,
    unitLabelWidth: widthOf(area.querySelector('[data-measure-unit]')),
    moreChipWidth: widthOf(area.querySelector('[data-measure-more]')),
    chips
  }
}

function sameWidths(a: UsageRowWidths | null, b: UsageRowWidths): boolean {
  if (!a) {
    return false
  }
  const close = (x: number, y: number) => Math.abs(x - y) < 0.5
  const providers = Object.keys(b.chips)
  return (
    close(a.available, b.available) &&
    close(a.chipGap, b.chipGap) &&
    close(a.unitLabelWidth, b.unitLabelWidth) &&
    close(a.moreChipWidth, b.moreChipWidth) &&
    providers.length === Object.keys(a.chips).length &&
    providers.every((provider) =>
      b.chips[provider]!.every((width, level) => close(a.chips[provider]?.[level] ?? -1, width))
    )
  )
}

/** The elements whose natural widths the row's form is chosen from. */
const MEASURED_ELEMENTS = '[data-measure-chip],[data-measure-unit],[data-measure-more]'

/**
 * Natural widths for choosing the usage row's form. Why not measure the shown row: a choice that
 * changes what it measures feeds back into the next choice and can loop (React #185).
 */
export function useUsageRowWidths(): [RefCallback<HTMLElement>, UsageRowWidths | null] {
  const [area, setArea] = useState<HTMLElement | null>(null)
  const [widths, setWidths] = useState<UsageRowWidths | null>(null)
  // Why layout: the first read lands before paint, so a narrow bar never flashes the full row.
  useLayoutEffect(() => {
    if (!area || typeof ResizeObserver !== 'function') {
      return
    }
    const read = (): void => {
      const next = readUsageRowWidths(area)
      setWidths((previous) => (sameWidths(previous, next) ? previous : next))
    }
    const resize = new ResizeObserver(read)
    resize.observe(area)
    for (const element of area.querySelectorAll(MEASURED_ELEMENTS)) {
      resize.observe(element)
    }
    // Why: providers joining or leaving add measuring elements the resize observer hasn't seen.
    const mutations = new MutationObserver(() => {
      for (const element of area.querySelectorAll(MEASURED_ELEMENTS)) {
        resize.observe(element)
      }
      read()
    })
    mutations.observe(area, { childList: true, subtree: true })
    read()
    return () => {
      resize.disconnect()
      mutations.disconnect()
    }
  }, [area])
  return [setArea, widths]
}
