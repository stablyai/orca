export const MERMAID_ZOOM_MIN = 0.1
export const MERMAID_ZOOM_MAX = 8
export const MERMAID_ZOOM_STEP = 0.25
export const MERMAID_ZOOM_WHEEL_SENSITIVITY = 0.01
export const MERMAID_FIT_PADDING = 16

type MermaidSvgSize = {
  width: number
  height: number | null
}

export function clampMermaidZoom(value: number): number {
  if (!Number.isFinite(value)) {
    return 1
  }

  return Math.max(MERMAID_ZOOM_MIN, Math.min(MERMAID_ZOOM_MAX, value))
}

export function nudgeMermaidZoom(current: number, direction: 1 | -1): number {
  return clampMermaidZoom(current + direction * MERMAID_ZOOM_STEP)
}

// Why: trackpad pinch and modifier-wheel fire many small delta events. Stepping
// by a fixed 0.25 feels jerky; an exponential curve lets small deltas produce
// proportionally small scale changes for a smooth feel.
export function continuousMermaidZoom(current: number, deltaY: number): number {
  const factor = Math.exp(-deltaY * MERMAID_ZOOM_WHEEL_SENSITIVITY)
  return clampMermaidZoom(current * factor)
}

type FitInputs = {
  svgWidth: number
  svgHeight: number | null
  viewportWidth: number
  viewportHeight: number
  padding?: number
}

// Returns the zoom level that makes the SVG fit inside the viewport with
// optional padding. If the SVG has no height we fall back to width-only fit so
// the result is still useful (Mermaid sometimes omits height).
export function fitMermaidZoom(inputs: FitInputs): number {
  const padding = inputs.padding ?? MERMAID_FIT_PADDING
  const availableWidth = Math.max(0, inputs.viewportWidth - padding * 2)
  const availableHeight = Math.max(0, inputs.viewportHeight - padding * 2)

  if (inputs.svgWidth <= 0 || availableWidth <= 0) {
    return 1
  }

  const widthFit = availableWidth / inputs.svgWidth
  if (inputs.svgHeight === null || inputs.svgHeight <= 0 || availableHeight <= 0) {
    return clampMermaidZoom(widthFit)
  }

  const heightFit = availableHeight / inputs.svgHeight
  return clampMermaidZoom(Math.min(widthFit, heightFit))
}

function parseMermaidDimension(value: string | null): number | null {
  if (!value) {
    return null
  }

  const trimmed = value.trim()
  if (trimmed.endsWith('%')) {
    return null
  }

  const match = trimmed.match(/^([0-9]+(?:\.[0-9]+)?)(?:px)?$/)
  if (!match) {
    return null
  }

  const parsed = Number.parseFloat(match[1])
  return Number.isFinite(parsed) ? parsed : null
}

export function getMermaidSvgBaseSize(attributes: {
  width: string | null
  height: string | null
  viewBox: string | null
}): MermaidSvgSize | null {
  const width = parseMermaidDimension(attributes.width)
  const height = parseMermaidDimension(attributes.height)
  if (width !== null) {
    return { width, height }
  }

  if (!attributes.viewBox) {
    return null
  }

  const parts = attributes.viewBox
    .trim()
    .split(/[\s,]+/)
    .map((part) => Number.parseFloat(part))
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) {
    return null
  }

  return {
    width: parts[2],
    height: parts[3]
  }
}
