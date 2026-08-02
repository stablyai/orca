export function removeDiffSectionMeasuredHeight(
  heights: Record<number, number>,
  index: number
): Record<number, number> {
  if (!(index in heights)) {
    return heights
  }
  const { [index]: _removed, ...rest } = heights
  void _removed
  return rest
}
