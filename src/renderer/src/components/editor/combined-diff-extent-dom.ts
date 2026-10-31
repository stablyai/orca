import type { Virtualizer } from '@tanstack/react-virtual'
import { CombinedDiffExtent } from './combined-diff-extent'
import { getCombinedDiffFocusOwner } from './combined-diff-overflow'
import { COMBINED_DIFF_ROW_SELECTOR } from './combined-diff-viewport'

const prefixHeight = (viewport: HTMLElement): number =>
  viewport.querySelector('[data-combined-diff-prefix]')?.getBoundingClientRect().height ?? 0

const owners = new WeakMap<HTMLElement, ReturnType<typeof createOwner>>()

function createOwner(viewport: HTMLElement) {
  let mark: ((offset: number) => void) | undefined
  const extent = new CombinedDiffExtent({
    position: () => viewport.scrollTop,
    height: () => viewport.clientHeight,
    project: (items, height) => {
      const content = viewport.querySelector<HTMLElement>('[data-combined-diff-extent]')
      const prefix = prefixHeight(viewport)
      if (content) {
        content.style.height = `${Math.max(0, height - prefix)}px`
      }
      viewport.querySelectorAll<HTMLElement>(COMBINED_DIFF_ROW_SELECTOR).forEach((row) => {
        const item = items[Number(row.dataset.index)]
        if (item) {
          row.style.top = `${item.start - prefix}px`
        }
      })
    },
    write: (offset) => {
      mark?.(offset)
      viewport.scrollTop = offset
    }
  })
  return {
    extent,
    setMark: (next: typeof mark) => {
      mark = next
    }
  }
}

export function getCombinedDiffExtent(viewport: HTMLElement): CombinedDiffExtent {
  let owner = owners.get(viewport)
  if (!owner) {
    owner = createOwner(viewport)
    owners.set(viewport, owner)
  }
  return owner.extent
}

export function publishCombinedDiffMeasurements(
  instance: Virtualizer<HTMLDivElement, Element>
): void {
  instance.shouldAdjustScrollPositionOnItemSizeChange = () => false
  const viewport = instance.scrollElement
  if (!viewport) {
    return
  }
  const active = viewport.ownerDocument.activeElement
  const row = active ? getCombinedDiffFocusOwner(active) : null
  const prefix = prefixHeight(viewport)
  instance.getTotalSize()
  const measured = instance.measurementsCache
  const focused = row && viewport.contains(row) ? measured[Number(row.dataset.index)] : undefined
  getCombinedDiffExtent(viewport).publish(measured, focused?.key, prefix)
}

export function scrollCombinedDiffTo(viewport: HTMLElement, target: number): boolean {
  return getCombinedDiffExtent(viewport).navigate(target)
}

export function scrollCombinedDiffToIndex(
  instance: Virtualizer<HTMLDivElement, Element>,
  index: number,
  offset = 0
): void {
  publishCombinedDiffMeasurements(instance)
  const viewport = instance.scrollElement
  const item = viewport && getCombinedDiffExtent(viewport).item(index)
  if (viewport && item) {
    const owner = getCombinedDiffExtent(viewport)
    owner.restore({ key: item.key, offset, gap: 0 })
  }
}

export function connectCombinedDiffExtent(
  viewport: HTMLElement,
  mark?: (offset: number) => void,
  refresh?: () => void
): () => void {
  const extent = getCombinedDiffExtent(viewport)
  owners.get(viewport)?.setMark(mark)
  const overflowAnchor = viewport.style.overflowAnchor
  viewport.style.overflowAnchor = 'none'
  const input = (): void => extent.input()
  const scroll = (): void => extent.scrolled()
  const events = ['wheel', 'touchmove', 'pointerdown'] as const
  events.forEach((event) =>
    viewport.addEventListener(event, input, { capture: true, passive: true })
  )
  viewport.addEventListener('scroll', scroll, { passive: true })
  const resize = new ResizeObserver(() => {
    refresh?.()
    scroll()
  })
  resize.observe(viewport)
  return () => {
    resize.disconnect()
    events.forEach((event) => viewport.removeEventListener(event, input, true))
    viewport.removeEventListener('scroll', scroll)
    viewport.style.overflowAnchor = overflowAnchor
    owners.delete(viewport)
  }
}
