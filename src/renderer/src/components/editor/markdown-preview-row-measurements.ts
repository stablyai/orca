import type { Virtualizer } from '@tanstack/react-virtual'

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
