export type TreemapInput = {
  id: string
  label: string
  sizeBytes: number
  groupedLabels?: string[]
}

export type TreemapRect = TreemapInput & {
  x: number
  y: number
  width: number
  height: number
  depth: number
  index: number
}

type Bounds = {
  x: number
  y: number
  width: number
  height: number
}

function sumSizes(items: readonly TreemapInput[]): number {
  return items.reduce((sum, item) => sum + Math.max(0, item.sizeBytes), 0)
}

// NUL can't appear in a path or worktree identity, so this never collides with a real id.
const TREEMAP_GROUP_ID = '\0treemap-group'
const TREEMAP_GROUP_MIN_SHARE = 0.01

// Folds items under 1% of the total into one box so the chart has no unreadable slivers.
// keepId stays out of the group so the selected item keeps its own box.
export function groupSmallTreemapItems(
  items: readonly TreemapInput[],
  keepId: string | null = null
): TreemapInput[] {
  const positive = items.filter((item) => item.sizeBytes > 0)
  const minSize = sumSizes(positive) * TREEMAP_GROUP_MIN_SHARE
  const isSmall = (item: TreemapInput): boolean => item.sizeBytes < minSize && item.id !== keepId
  const small = positive.filter(isSmall)
  if (small.length < 2 || small.length === positive.length) {
    return positive
  }
  return [
    ...positive.filter((item) => !isSmall(item)),
    {
      id: TREEMAP_GROUP_ID,
      label: '',
      sizeBytes: sumSizes(small),
      groupedLabels: small.map((item) => item.label)
    }
  ]
}

function splitBalanced(items: readonly TreemapInput[]): {
  first: TreemapInput[]
  second: TreemapInput[]
} {
  const total = sumSizes(items)
  if (items.length <= 1 || total <= 0) {
    return { first: [...items], second: [] }
  }

  const target = total / 2
  let running = 0
  let splitIndex = 0
  for (let index = 0; index < items.length; index += 1) {
    const next = running + Math.max(0, items[index].sizeBytes)
    if (index > 0 && Math.abs(target - running) < Math.abs(target - next)) {
      break
    }
    running = next
    splitIndex = index + 1
  }

  splitIndex = Math.min(items.length - 1, Math.max(1, splitIndex))
  return {
    first: items.slice(0, splitIndex),
    second: items.slice(splitIndex)
  }
}

function layoutTreemapRecursive(
  items: readonly TreemapInput[],
  bounds: Bounds,
  depth: number,
  aspectRatio: number,
  output: TreemapRect[]
): void {
  if (items.length === 0 || bounds.width <= 0 || bounds.height <= 0) {
    return
  }

  if (items.length === 1) {
    const item = items[0]
    output.push({
      ...item,
      ...bounds,
      depth,
      index: output.length
    })
    return
  }

  const total = sumSizes(items)
  if (total <= 0) {
    return
  }

  const { first, second } = splitBalanced(items)
  const firstSize = sumSizes(first)
  const ratio = firstSize / total

  // Bounds are percentages; aspectRatio converts width% into the same pixel scale as height%.
  if (bounds.width * aspectRatio >= bounds.height) {
    const firstWidth = bounds.width * ratio
    layoutTreemapRecursive(first, { ...bounds, width: firstWidth }, depth + 1, aspectRatio, output)
    layoutTreemapRecursive(
      second,
      {
        x: bounds.x + firstWidth,
        y: bounds.y,
        width: bounds.width - firstWidth,
        height: bounds.height
      },
      depth + 1,
      aspectRatio,
      output
    )
    return
  }

  const firstHeight = bounds.height * ratio
  layoutTreemapRecursive(first, { ...bounds, height: firstHeight }, depth + 1, aspectRatio, output)
  layoutTreemapRecursive(
    second,
    {
      x: bounds.x,
      y: bounds.y + firstHeight,
      width: bounds.width,
      height: bounds.height - firstHeight
    },
    depth + 1,
    aspectRatio,
    output
  )
}

// aspectRatio is the chart's pixel width ÷ height; output stays in percentages.
export function buildTreemapLayout(items: readonly TreemapInput[], aspectRatio = 1): TreemapRect[] {
  const filtered = items
    .filter((item) => item.sizeBytes > 0)
    .sort(
      (a, b) =>
        Number(!!a.groupedLabels) - Number(!!b.groupedLabels) ||
        b.sizeBytes - a.sizeBytes ||
        a.label.localeCompare(b.label)
    )
  const output: TreemapRect[] = []
  layoutTreemapRecursive(filtered, { x: 0, y: 0, width: 100, height: 100 }, 0, aspectRatio, output)
  return output
}

export type TreemapLabelTier = 'none' | 'name' | 'name-and-size'

// Mirrors the box classes in workspace-space-treemap.tsx: border, p-2, text-2xs leading-tight, mt-0.5.
const TREEMAP_BOX_BORDER_PX = 1
const TREEMAP_BOX_PADDING_PX = 8
const TREEMAP_LABEL_LINE_HEIGHT_PX = 11 * 1.25
const TREEMAP_SIZE_LINE_GAP_PX = 2
// About four characters plus an ellipsis, so a shown name is never just "a…".
const TREEMAP_LABEL_MIN_TEXT_WIDTH_PX = 32
// Widest formatBytes output ("1023 MB", "10.5 GB") is about 40 px at text-2xs.
const TREEMAP_SIZE_MIN_TEXT_WIDTH_PX = 44
const TREEMAP_BOX_CHROME_PX = 2 * (TREEMAP_BOX_BORDER_PX + TREEMAP_BOX_PADDING_PX)

export function resolveTreemapLabelTier(widthPx: number, heightPx: number): TreemapLabelTier {
  const textWidthPx = widthPx - TREEMAP_BOX_CHROME_PX
  if (textWidthPx < TREEMAP_LABEL_MIN_TEXT_WIDTH_PX) {
    return 'none'
  }
  const textHeightPx = heightPx - TREEMAP_BOX_CHROME_PX
  if (
    textWidthPx >= TREEMAP_SIZE_MIN_TEXT_WIDTH_PX &&
    textHeightPx >= 2 * TREEMAP_LABEL_LINE_HEIGHT_PX + TREEMAP_SIZE_LINE_GAP_PX
  ) {
    return 'name-and-size'
  }
  return textHeightPx >= TREEMAP_LABEL_LINE_HEIGHT_PX ? 'name' : 'none'
}
