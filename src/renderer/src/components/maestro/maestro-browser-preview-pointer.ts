export type MaestroBrowserPreviewPoint = { x: number; y: number }

export function maestroBrowserPreviewPoint(
  image: HTMLImageElement,
  event: Pick<MouseEvent, 'clientX' | 'clientY'>
): MaestroBrowserPreviewPoint | null {
  const bounds = image.getBoundingClientRect()
  const width = image.naturalWidth || bounds.width
  const height = image.naturalHeight || bounds.height
  if (bounds.width <= 0 || bounds.height <= 0 || width <= 0 || height <= 0) {
    return null
  }
  return {
    x: Math.max(
      0,
      Math.min(width - 1, Math.round(((event.clientX - bounds.left) / bounds.width) * width))
    ),
    y: Math.max(
      0,
      Math.min(height - 1, Math.round(((event.clientY - bounds.top) / bounds.height) * height))
    )
  }
}
