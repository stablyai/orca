import { useLayoutEffect, useRef, useState, type RefObject } from 'react'

export const BOT_ITEM_CHIPS_ATTRIBUTE = 'data-bot-item-chips'

const GAP_PX = 6
const FIT_MARGIN_PX = 1

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
  stacked: boolean,
  rowWidth: number
): boolean {
  const button = root.closest('button')
  if (!button || rowWidth === 0) {
    return stacked
  }
  if (!stacked) {
    return label.getBoundingClientRect().height > px(getComputedStyle(label).lineHeight) * 1.5
  }
  return (
    label.getBoundingClientRect().width +
      GAP_PX +
      tag.getBoundingClientRect().width +
      FIT_MARGIN_PX >
    rowWidth - chrome(button)
  )
}

// Shrink the filled pill to its label after Recommended wraps; CSS wrap alone keeps it full-width.
export function useBotItemChipStacked(
  enabled: boolean,
  recommendedText: string
): {
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
    let measuredWidth: number | undefined
    const measure = (): void => {
      const width = row.getBoundingClientRect().width
      if (width === measuredWidth) {
        return
      }
      measuredWidth = width
      const labelNode = label.current
      const tagNode = tag.current
      if (labelNode && tagNode) {
        setStacked((was) => shouldStack(node, labelNode, tagNode, was, width))
      }
    }
    measure()
    if (typeof ResizeObserver === 'undefined') {
      return
    }
    const observer = new ResizeObserver(measure)
    observer.observe(row)
    return () => observer.disconnect()
  }, [enabled, recommendedText])
  return { root, label, tag, stacked }
}
