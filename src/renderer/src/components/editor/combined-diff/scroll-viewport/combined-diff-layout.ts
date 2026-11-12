export type DiffItemExtent = Readonly<{ key: string; height: number }>
export type DiffReadingAnchor = Readonly<{ key: string; offset: number }>
export type DiffItemLayout = Readonly<{
  key: string
  start: number
  height: number
  renderedStart: number
  renderedHeight: number
  scrollOffset: number
  visible: boolean
}>
export type DiffViewportLayout = Readonly<{
  revision: number
  scrollTop: number
  logicalTop: number
  logicalHeight: number
  scrollHeight: number
  renderedTop: number
  leadingSlack: number
  trailingSlack: number
  items: readonly DiffItemLayout[]
}>

export function diffViewportInputMax(layout: DiffViewportLayout, height: number): number {
  return Math.max(0, layout.logicalHeight + layout.trailingSlack - height)
}

export function diffRevealDisplacement(input: {
  top: number
  bottom: number
  height: number
  chrome: number
  lineHeight: number
  surroundingLines: number
  surroundingLinesStyle: 'default' | 'all'
  source: string | null | undefined
  minimalReveal: boolean
  multipleSelections: boolean
  verticalType: number
}): number {
  const height = Math.max(0, input.height - input.chrome)
  const ignoreContext =
    (input.source === 'mouse' || input.minimalReveal) && input.surroundingLinesStyle === 'default'
  const context = ignoreContext
    ? 0
    : Math.min(height / input.lineHeight / 2, input.surroundingLines)
  const paddingTop = ignoreContext
    ? input.minimalReveal
      ? 0
      : input.lineHeight
    : context * input.lineHeight
  const paddingBottom =
    Math.max(0, context - 1) * input.lineHeight +
    (!input.minimalReveal && (input.verticalType === 0 || input.verticalType === 4)
      ? input.lineHeight
      : 0)
  const start = input.top - paddingTop
  const end = input.bottom + paddingBottom
  const span = end - start
  const outside = start < input.chrome || end > input.height
  if (span > height) {
    return input.multipleSelections ? input.top : input.chrome + paddingTop
  }
  if (input.verticalType === 5 || input.verticalType === 6) {
    if (input.verticalType === 6 && !outside) {
      return input.top
    }
    const gap = Math.min(Math.max(5 * input.lineHeight, height * 0.2), height - span)
    return input.chrome + paddingTop + gap
  }
  if (input.verticalType === 1 || input.verticalType === 2) {
    if (input.verticalType === 2 && !outside) {
      return input.top
    }
    return input.chrome + paddingTop + (height - span) / 2
  }
  if (input.verticalType === 3 || start < input.chrome) {
    return input.chrome + paddingTop
  }
  if (input.verticalType === 4 || end > input.height) {
    return input.height - (end - input.top)
  }
  return input.top
}

type DiffAnchorGeometry = {
  start: number
  height: number
  renderedHeight: number
  currentTop: number
  nativeTarget: number
  chrome: number
  originalMax: number
  modifiedMax: number
  originalToModified: number
  pane: 'original' | 'modified'
}

export function diffNativeScrollOffsets(input: {
  requested: number
  originalMax: number
  modifiedMax: number
  originalToModified: number
}): { original: number; modified: number } {
  const lower = Math.max(0, -input.originalToModified)
  const upper = Math.min(input.originalMax, input.modifiedMax - input.originalToModified)
  const clamp = (value: number, min: number, max: number): number =>
    Math.max(min, Math.min(value, max))
  const original =
    lower <= upper
      ? clamp(input.requested, lower, upper)
      : input.originalToModified > 0
        ? 0
        : input.originalMax
  return { original, modified: clamp(original + input.originalToModified, 0, input.modifiedMax) }
}

function anchorProjection(input: DiffAnchorGeometry, top: number): { top: number; rowTop: number } {
  const maximum = Math.max(0, input.height - input.renderedHeight)
  const requested = Math.max(0, Math.min(top - input.start, maximum))
  const offsets = diffNativeScrollOffsets({ ...input, requested })
  const pane = input.pane === 'original' ? offsets.original : offsets.modified
  const rowTop = input.start - top + requested
  return { top: rowTop + input.chrome + input.nativeTarget - pane, rowTop }
}

function anchorBoundaries(input: DiffAnchorGeometry): number[] {
  const maximum = Math.max(0, input.height - input.renderedHeight)
  const lower = Math.max(0, -input.originalToModified)
  const upper = Math.min(input.originalMax, input.modifiedMax - input.originalToModified)
  const clamp = (value: number): number => Math.max(0, Math.min(value, maximum))
  return [
    ...new Set([
      input.start,
      input.start + maximum,
      input.start + clamp(lower),
      input.start + clamp(upper)
    ])
  ].sort((left, right) => left - right)
}

export function resolveDiffAnchorTop(input: DiffAnchorGeometry & { displacement: number }): number {
  const clamp = (value: number, min: number, max: number): number =>
    Math.max(min, Math.min(value, max))
  const boundaries = anchorBoundaries(input)
  const project = (top: number): number => anchorProjection(input, top).top
  const candidates: number[] = []
  const first = boundaries[0]
  const last = boundaries.at(-1)!
  const atFirst = project(first)
  const atLast = project(last)
  if (input.displacement >= atFirst) {
    candidates.push(first + atFirst - input.displacement)
  }
  if (input.displacement <= atLast) {
    candidates.push(last + atLast - input.displacement)
  }
  for (let index = 1; index < boundaries.length; index++) {
    const start = boundaries[index - 1]
    const end = boundaries[index]
    const from = project(start)
    const to = project(end)
    if (input.displacement > from || input.displacement < to) {
      continue
    }
    candidates.push(
      from === to ? clamp(input.currentTop, start, end) : start + from - input.displacement
    )
  }
  return candidates.reduce((best, value) =>
    Math.abs(value - input.currentTop) < Math.abs(best - input.currentTop) ? value : best
  )
}

export function fitDiffAnchorRange(
  input: DiffAnchorGeometry & {
    preferredTop: number
    nativeEnd: number
    viewportHeight: number
    nativeHeight: number
    headerHeight: number
    margin: number
  }
): number | null {
  const maximum = Math.max(0, input.height - input.renderedHeight)
  const boundaries = [
    ...new Set([
      ...anchorBoundaries(input),
      input.start + maximum + Math.max(0, input.renderedHeight - input.headerHeight)
    ])
  ].sort((a, b) => a - b)
  const residuals = (top: number): readonly number[] => {
    const projected = anchorProjection(input, top)
    const bodyTop = projected.rowTop + input.chrome
    const headerBottom =
      projected.rowTop +
      Math.max(0, Math.min(-projected.rowTop, input.renderedHeight - input.headerHeight)) +
      input.headerHeight
    const end = projected.top + input.nativeEnd - input.nativeTarget + input.margin
    return [
      projected.top,
      projected.top - bodyTop,
      projected.top - headerBottom,
      input.viewportHeight - end,
      bodyTop + input.nativeHeight - end
    ]
  }
  let best: number | null = null
  const edges = [-Infinity, ...boundaries, Infinity]
  for (let index = 1; index < edges.length; index++) {
    let low = edges[index - 1]
    let high = edges[index]
    const a = Number.isFinite(low) ? low : high - 1
    const b = Number.isFinite(high) ? high : low + 1
    if (a === b) {
      continue
    }
    const from = residuals(a)
    const to = residuals(b)
    for (let constraint = 0; constraint < from.length; constraint++) {
      const slope = (to[constraint] - from[constraint]) / (b - a)
      if (Math.abs(slope) < 1e-9) {
        if (from[constraint] < -1e-7) {
          low = Infinity
          break
        }
      } else {
        const boundary = a - from[constraint] / slope
        if (slope > 0) {
          low = Math.max(low, boundary)
        } else {
          high = Math.min(high, boundary)
        }
      }
    }
    if (low > high) {
      continue
    }
    const candidate = Math.max(low, Math.min(input.preferredTop, high))
    if (
      best === null ||
      Math.abs(candidate - input.preferredTop) < Math.abs(best - input.preferredTop)
    ) {
      best = candidate
    }
  }
  return best
}
