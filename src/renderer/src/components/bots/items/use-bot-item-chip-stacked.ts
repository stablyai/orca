import { useLayoutEffect, useRef, useState, type RefObject } from 'react'

export const BOT_ITEM_CHIPS_ATTRIBUTE = 'data-bot-item-chips'

const GAP_PX = 6

function px(value: string): number {
  return Number.parseFloat(value) || 0
}

function chrome(button: HTMLElement): number {
  const style = getComputedStyle(button)
  return (
    px(style.paddingLeft) +
    px(style.paddingRight) +
    px(style.borderLeftWidth) +
    px(style.borderRightWidth)
  )
}

function shouldStack(
  root: HTMLElement,
  label: HTMLElement,
  tag: HTMLElement,
  stacked: boolean
): boolean {
  const button = root.closest('button')
  const row = root.closest<HTMLElement>(`[${BOT_ITEM_CHIPS_ATTRIBUTE}]`)
  if (!button || !row || row.clientWidth === 0) {
    return stacked
  }
  if (!stacked) {
    return label.offsetHeight > px(getComputedStyle(label).lineHeight) * 1.5
  }
  return label.offsetWidth + GAP_PX + tag.offsetWidth > row.clientWidth - chrome(button)
}

// Shrink the filled pill to its label after Recommended wraps; CSS wrap alone keeps it full-width.
export function useBotItemChipStacked(enabled: boolean): {
  root: RefObject<HTMLSpanElement | null>
  label: RefObject<HTMLSpanElement | null>
  tag: RefObject<HTMLSpanElement | null>
  stacked: boolean
} {
  const root = useRef<HTMLSpanElement | null>(null)
  const label = useRef<HTMLSpanElement | null>(null)
  const tag = useRef<HTMLSpanElement | null>(null)
  const [stacked, setStacked] = useState(false)
  useLayoutEffect(() => {
    const node = root.current
    const row = node?.closest<HTMLElement>(`[${BOT_ITEM_CHIPS_ATTRIBUTE}]`)
    if (!enabled || !node || !row) {
      return
    }
    const measure = (): void => {
      if (label.current && tag.current) {
        setStacked((was) => shouldStack(node, label.current!, tag.current!, was))
      }
    }
    measure()
    if (typeof ResizeObserver === 'undefined') {
      return
    }
    const observer = new ResizeObserver(measure)
    observer.observe(row)
    return () => observer.disconnect()
  }, [enabled])
  return { root, label, tag, stacked }
}
