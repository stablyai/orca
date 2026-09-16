import type { TerminalRichInputImageAttachment } from './terminal-rich-input-types'

const pendingPreviewRevocations = new Map<string, number>()

export function syncTerminalRichInputPreviewUrls(
  previous: readonly TerminalRichInputImageAttachment[],
  next: readonly TerminalRichInputImageAttachment[]
): void {
  const retained = new Set(next.flatMap(({ previewSrc }) => (previewSrc ? [previewSrc] : [])))
  for (const previewSrc of retained) {
    const timer = pendingPreviewRevocations.get(previewSrc)
    if (timer !== undefined) {
      window.clearTimeout(timer)
      pendingPreviewRevocations.delete(previewSrc)
    }
  }
  for (const { previewSrc } of previous) {
    if (
      !previewSrc?.startsWith('blob:') ||
      retained.has(previewSrc) ||
      pendingPreviewRevocations.has(previewSrc)
    ) {
      continue
    }
    const timer = window.setTimeout(() => {
      URL.revokeObjectURL?.(previewSrc)
      pendingPreviewRevocations.delete(previewSrc)
    }, 30_000)
    pendingPreviewRevocations.set(previewSrc, timer)
  }
}
