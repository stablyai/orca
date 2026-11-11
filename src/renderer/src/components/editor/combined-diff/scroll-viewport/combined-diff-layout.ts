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

export function diffContentHeight(items: readonly DiffItemExtent[]): number {
  return items.reduce((height, item) => height + item.height, 0)
}

export function layoutDiffViewport(input: {
  items: readonly DiffItemExtent[]
  height: number
  logicalTop: number
  revision: number
  preserveSlack?: boolean
}): DiffViewportLayout {
  const logicalHeight = diffContentHeight(input.items)
  const naturalMax = Math.max(0, logicalHeight - input.height)
  const leadingSlack = input.preserveSlack ? Math.max(0, -input.logicalTop) : 0
  const trailingSlack = input.preserveSlack ? Math.max(0, input.logicalTop - naturalMax) : 0
  const scrollHeight = leadingSlack + logicalHeight + trailingSlack
  const scrollTop = Math.max(
    0,
    Math.min(input.logicalTop + leadingSlack, Math.max(0, scrollHeight - input.height))
  )
  const logicalTop = scrollTop - leadingSlack
  let start = 0
  let renderedStart = leadingSlack
  let hiddenAbove = 0
  const items = input.items.map((item): DiffItemLayout => {
    const renderedHeight = Math.min(item.height, input.height)
    const maxOffset = item.height - renderedHeight
    const scrollOffset = Math.max(0, Math.min(logicalTop - start, maxOffset))
    const result = {
      key: item.key,
      start,
      height: item.height,
      renderedStart,
      renderedHeight,
      scrollOffset,
      visible: start + item.height > logicalTop && start < logicalTop + input.height
    }
    hiddenAbove += scrollOffset
    start += item.height
    renderedStart += renderedHeight
    return result
  })
  return {
    revision: input.revision,
    scrollTop,
    logicalTop,
    logicalHeight,
    scrollHeight,
    renderedTop: scrollTop - hiddenAbove,
    leadingSlack,
    trailingSlack,
    items
  }
}

export function diffAnchorAt(
  items: readonly DiffItemExtent[],
  offset: number
): DiffReadingAnchor | null {
  let start = 0
  for (const item of items) {
    if (offset < start + item.height) {
      return { key: item.key, offset: offset - start }
    }
    start += item.height
  }
  const last = items.at(-1)
  return last ? { key: last.key, offset: last.height } : null
}

export function diffAnchorOffset(
  items: readonly DiffItemExtent[],
  anchor: DiffReadingAnchor,
  affinity: 'start' | 'end' = 'end'
): number | null {
  let start = 0
  for (const item of items) {
    if (item.key === anchor.key) {
      return (
        start + (anchor.offset < item.height ? anchor.offset : affinity === 'end' ? item.height : 0)
      )
    }
    start += item.height
  }
  return null
}

export function mapDiffViewportTop(input: {
  previous: readonly DiffItemExtent[]
  next: readonly DiffItemExtent[]
  top: number
  height: number
  direction: 'up' | 'down' | undefined
}): number {
  const viewportOffset = input.direction === 'up' ? input.height : 0
  const oldHeight = diffContentHeight(input.previous)
  const edge = Math.max(0, Math.min(input.top + viewportOffset, oldHeight))
  const anchor = diffAnchorAt(input.previous, edge)
  if (!anchor) {
    return input.top
  }
  const mapped =
    edge === oldHeight
      ? diffContentHeight(input.next)
      : diffAnchorOffset(input.next, anchor, input.direction === 'up' ? 'end' : 'start')
  if (mapped !== null) {
    return mapped - (edge - input.top)
  }

  // Retain a surviving neighbor when the anchored file itself disappears.
  const oldIndex = input.previous.findIndex((item) => item.key === anchor.key)
  const nextKeys = new Set(input.next.map((item) => item.key))
  let oldStart = 0
  for (let index = 0; index < input.previous.length; index++) {
    const item = input.previous[index]
    if (index > oldIndex && nextKeys.has(item.key)) {
      const nextStart = diffAnchorOffset(input.next, { key: item.key, offset: 0 })!
      return nextStart - (oldStart - input.top)
    }
    oldStart += item.height
  }
  return Math.min(input.top, Math.max(0, diffContentHeight(input.next) - input.height))
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

export function resolveDiffAnchorTop(input: {
  start: number
  height: number
  renderedHeight: number
  currentTop: number
  nativeTarget: number
  chrome: number
  displacement: number
  originalMax: number
  modifiedMax: number
  originalToModified: number
  pane: 'original' | 'modified'
}): number {
  const maximum = Math.max(0, input.height - input.renderedHeight)
  const lower = Math.max(0, -input.originalToModified)
  const upper = Math.min(input.originalMax, input.modifiedMax - input.originalToModified)
  const clamp = (value: number, min: number, max: number): number =>
    Math.max(min, Math.min(value, max))
  const project = (top: number): number => {
    const requested = clamp(top - input.start, 0, maximum)
    const original =
      lower <= upper
        ? clamp(requested, lower, upper)
        : input.originalToModified > 0
          ? 0
          : input.originalMax
    const pane =
      input.pane === 'original'
        ? original
        : clamp(original + input.originalToModified, 0, input.modifiedMax)
    return input.start - top + requested + input.chrome + input.nativeTarget - pane
  }
  const boundaries = [
    ...new Set([
      input.start,
      input.start + maximum,
      input.start + clamp(lower, 0, maximum),
      input.start + clamp(upper, 0, maximum)
    ])
  ].sort((left, right) => left - right)
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
