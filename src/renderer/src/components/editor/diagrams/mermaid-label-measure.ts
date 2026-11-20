const OVERFLOW_SLACK_PX = 0.5

// Mermaid wraps a label only when the measured width equals the requested max width.
// Zoom and subpixel layout miss that equality, so an overflowing line stays nowrap (#45573).
export function mermaidLabelBox(element: Element, measured: DOMRect): DOMRect {
  if (!(element instanceof HTMLElement)) {
    return measured
  }
  const maxWidth = Number.parseFloat(element.style.maxWidth)
  if (!Number.isFinite(maxWidth) || maxWidth <= 0) {
    return measured
  }
  if (element.scrollWidth <= element.clientWidth + OVERFLOW_SLACK_PX) {
    return measured
  }
  if (Math.abs(measured.width - maxWidth) < OVERFLOW_SLACK_PX) {
    return measured
  }
  return new DOMRect(measured.x, measured.y, maxWidth, measured.height)
}

export async function withMermaidLabelMeasure<T>(render: () => Promise<T>): Promise<T> {
  const proto = Element.prototype
  const original = proto.getBoundingClientRect
  proto.getBoundingClientRect = function (this: Element): DOMRect {
    return mermaidLabelBox(this, original.call(this))
  }
  try {
    return await render()
  } finally {
    proto.getBoundingClientRect = original
  }
}
