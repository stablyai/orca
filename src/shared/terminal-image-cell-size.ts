export type TerminalImageCellSize = { width: number; height: number }

/** CSS cell dimensions stay fractional; device pixels and rounded query replies differ. */
export function readTerminalImageCellSize(value: unknown): TerminalImageCellSize | null {
  if (!value || typeof value !== 'object' || !('width' in value) || !('height' in value)) {
    return null
  }
  const { width, height } = value
  if (
    typeof width !== 'number' ||
    typeof height !== 'number' ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return null
  }
  return { width, height }
}
