type Rect = Pick<DOMRect, 'left' | 'top' | 'right' | 'bottom'>

export function clipEmbeddedBrowser(rect: Rect, bounds: Rect, occluders: readonly Rect[]): string {
  let visible: Rect[] = [
    {
      left: Math.max(rect.left, bounds.left),
      top: Math.max(rect.top, bounds.top),
      right: Math.min(rect.right, bounds.right),
      bottom: Math.min(rect.bottom, bounds.bottom)
    }
  ]
  for (const blocker of occluders) {
    visible = visible.flatMap((area) => {
      const left = Math.max(area.left, blocker.left)
      const top = Math.max(area.top, blocker.top)
      const right = Math.min(area.right, blocker.right)
      const bottom = Math.min(area.bottom, blocker.bottom)
      if (left >= right || top >= bottom) {
        return [area]
      }
      return [
        { ...area, bottom: top },
        { ...area, top: bottom },
        { left: area.left, top, right: left, bottom },
        { left: right, top, right: area.right, bottom }
      ].filter((part) => part.right > part.left && part.bottom > part.top)
    })
  }
  const paths = visible
    .filter((area) => area.right > area.left && area.bottom > area.top)
    .map(
      (area) =>
        `M${area.left - rect.left},${area.top - rect.top}H${area.right - rect.left}V${area.bottom - rect.top}H${area.left - rect.left}Z`
    )
  return paths.length ? `path('${paths.join(' ')}')` : 'inset(100%)'
}
