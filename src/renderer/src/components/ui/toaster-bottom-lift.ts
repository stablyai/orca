export function getToasterBottomLift(
  rects: readonly Pick<DOMRectReadOnly, 'left' | 'right' | 'top'>[],
  viewportHeight: number,
  column: { left: number; right: number },
  gap: number,
  requiredRoom: number
): number {
  let toastBottom = viewportHeight
  for (const rect of rects) {
    if (rect.right > column.left && rect.left < column.right) {
      toastBottom = Math.min(toastBottom, rect.top - gap)
    }
  }
  return toastBottom >= requiredRoom ? viewportHeight - toastBottom : 0
}
