export function rectIn(
  el: HTMLElement,
  stageRect: DOMRect
): { left: number; right: number; top: number; bottom: number; cx: number; cy: number } {
  const r = el.getBoundingClientRect()
  return {
    left: r.left - stageRect.left,
    right: r.right - stageRect.left,
    top: r.top - stageRect.top,
    bottom: r.bottom - stageRect.top,
    cx: r.left - stageRect.left + r.width / 2,
    cy: r.top - stageRect.top + r.height / 2
  }
}

export function arrowPathFromCoordTo(
  coordEl: HTMLElement,
  targetEl: HTMLElement,
  stageRect: DOMRect
): string {
  const c = rectIn(coordEl, stageRect)
  const t = rectIn(targetEl, stageRect)
  const verticallyStacked = t.top >= c.bottom - 4
  if (verticallyStacked) {
    const x1 = c.right + 4
    const y1 = c.cy
    const x2 = t.right + 4
    const y2 = t.cy
    const apexX = Math.min(Math.max(x1, x2) + 36, stageRect.width - 8)
    return `M${x1} ${y1} C${apexX} ${y1}, ${apexX} ${y2}, ${x2} ${y2}`
  }
  const x1 = c.right + 4
  const y1 = c.cy
  const x2 = t.left - 8
  const y2 = t.cy
  const dx = (x2 - x1) * 0.55
  return `M${x1} ${y1} C${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`
}

export function bubblePathBetweenRows(
  stage: HTMLElement,
  fromRow: HTMLElement,
  toRow: HTMLElement
): string {
  const stageRect = stage.getBoundingClientRect()
  const fromCard = fromRow.closest('[data-feature-wall-card]')
  const toCard = toRow.closest('[data-feature-wall-card]')
  const fromR = rectIn(fromRow, stageRect)
  const toR = rectIn(toRow, stageRect)
  const fromC = fromCard instanceof HTMLElement ? rectIn(fromCard, stageRect) : fromR
  const toC = toCard instanceof HTMLElement ? rectIn(toCard, stageRect) : toR
  const verticallyStacked = toC.top >= fromC.bottom - 4 || fromC.top >= toC.bottom - 4
  if (verticallyStacked) {
    const x1 = fromC.right + 4
    const y1 = fromR.cy
    const x2 = toC.right + 4
    const y2 = toR.cy
    const apexX = Math.min(Math.max(x1, x2) + 36, stageRect.width - 8)
    return `M ${x1} ${y1} C ${apexX} ${y1}, ${apexX} ${y2}, ${x2} ${y2}`
  }
  const x1 = fromC.right + 4
  const y1 = fromR.cy
  const x2 = toC.left - 8
  const y2 = toR.cy
  const dx = (x2 - x1) * 0.55
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`
}
