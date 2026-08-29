export type ResourceManagerPosition = {
  x: number
  y: number
}

type ResourceManagerDragBounds = {
  current: ResourceManagerPosition
  proposed: ResourceManagerPosition
  rect: Pick<DOMRect, 'bottom' | 'height' | 'left' | 'right' | 'top' | 'width'>
  viewportHeight: number
  viewportWidth: number
  margin: number
  recoveryHeight: number
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum)
}

export function clampResourceManagerPosition({
  current,
  proposed,
  rect,
  viewportHeight,
  viewportWidth,
  margin,
  recoveryHeight
}: ResourceManagerDragBounds): ResourceManagerPosition {
  const minimumX = current.x + margin - rect.left
  const maximumX = current.x + viewportWidth - margin - rect.right
  const maximumVisibleX = current.x + viewportWidth - margin - rect.left
  const minimumY = current.y + margin - rect.top
  const maximumY = current.y + viewportHeight - margin - rect.bottom
  const maximumVisibleY = current.y + viewportHeight - margin - recoveryHeight - rect.top

  // Why: an unusually tall panel cannot fit vertically, so keeping its header
  // visible preserves the drag, reset, and close recovery controls.
  const y =
    rect.height > viewportHeight - margin * 2
      ? clamp(proposed.y, minimumY, maximumVisibleY)
      : clamp(proposed.y, minimumY, maximumY)

  return {
    x:
      rect.width > viewportWidth - margin * 2
        ? clamp(proposed.x, minimumX, maximumVisibleX)
        : clamp(proposed.x, minimumX, maximumX),
    y
  }
}
