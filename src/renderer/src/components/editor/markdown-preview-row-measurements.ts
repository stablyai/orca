import type { VirtualItem, Virtualizer } from '@tanstack/react-virtual'

export function refreshMarkdownPreviewRowMeasurements(
  virtualizer: Virtualizer<HTMLDivElement, HTMLDivElement>,
  body: HTMLDivElement | null,
  reset: boolean
): void {
  if (reset) {
    virtualizer.measure()
    // Rebuild cleared slots before recording unchanged row sizes.
    virtualizer.getVirtualItems()
  }
  for (const row of body?.querySelectorAll<HTMLDivElement>('[data-preview-block-loaded]') ?? []) {
    const index = Number(row.dataset.index)
    if (Number.isInteger(index) && index >= 0) {
      virtualizer.resizeItem(index, Math.round(row.getBoundingClientRect().height))
    }
  }
}

export function shouldAdjustMarkdownPreviewRowScroll(
  item: VirtualItem,
  _delta: number,
  virtualizer: Virtualizer<HTMLDivElement, HTMLDivElement>
): boolean {
  // Static blocks reflow on resize even after an upward scroll or viewport clamp.
  const offset = (virtualizer.scrollOffset ?? 0) + virtualizer.scrollAdjustments
  return virtualizer.itemSizeCache.has(item.key) ? item.end <= offset : item.start < offset
}

export function pruneMarkdownPreviewRowMeasurements(
  virtualizer: Virtualizer<HTMLDivElement, HTMLDivElement>
): void {
  const keys = new Set(
    Array.from({ length: virtualizer.options.count }, (_, index) =>
      virtualizer.options.getItemKey(index)
    )
  )
  for (const key of virtualizer.itemSizeCache.keys()) {
    if (!keys.has(key)) {
      virtualizer.itemSizeCache.delete(key)
    }
  }
}
