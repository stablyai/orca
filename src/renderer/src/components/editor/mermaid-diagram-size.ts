import type { SurfaceContentDimensions } from './surface-zoom'

// Why: with the default useMaxWidth, mermaid emits width="100%" plus an inline
// max-width, so the viewBox is the only place the diagram's real size survives.
export function parseDiagramViewBoxSize(viewBox: string | null): SurfaceContentDimensions | null {
  if (!viewBox) {
    return null
  }

  const parts = viewBox
    .trim()
    .split(/[\s,]+/)
    .map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) {
    return null
  }

  const [, , width, height] = parts
  if (width <= 0 || height <= 0) {
    return null
  }

  return { width, height }
}

function parseDiagramLengthAttribute(value: string | null): number | null {
  if (!value || value.endsWith('%')) {
    return null
  }

  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

export function getRenderedDiagramSize(
  container: HTMLElement | null
): SurfaceContentDimensions | null {
  const svg = container?.querySelector('svg')
  if (!svg) {
    return null
  }

  const viewBoxSize = parseDiagramViewBoxSize(svg.getAttribute('viewBox'))
  if (viewBoxSize) {
    return viewBoxSize
  }

  // Why: useMaxWidth: false diagrams carry px width/height attributes instead.
  const width = parseDiagramLengthAttribute(svg.getAttribute('width'))
  const height = parseDiagramLengthAttribute(svg.getAttribute('height'))
  return width !== null && height !== null ? { width, height } : null
}
