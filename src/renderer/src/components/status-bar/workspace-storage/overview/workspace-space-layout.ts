export type TreemapInput = {
  id: string
  label: string
  sizeBytes: number
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

  if (bounds.width >= bounds.height) {
    const firstWidth = bounds.width * ratio
    layoutTreemapRecursive(first, { ...bounds, width: firstWidth }, depth + 1, output)
    layoutTreemapRecursive(
      second,
      {
        x: bounds.x + firstWidth,
        y: bounds.y,
        width: bounds.width - firstWidth,
        height: bounds.height
      },
      depth + 1,
      output
    )
    return
  }

  const firstHeight = bounds.height * ratio
  layoutTreemapRecursive(first, { ...bounds, height: firstHeight }, depth + 1, output)
  layoutTreemapRecursive(
    second,
    {
      x: bounds.x,
      y: bounds.y + firstHeight,
      width: bounds.width,
      height: bounds.height - firstHeight
    },
    depth + 1,
    output
  )
}

export function buildTreemapLayout(items: readonly TreemapInput[]): TreemapRect[] {
  const filtered = items
    .filter((item) => item.sizeBytes > 0)
    .sort((a, b) => b.sizeBytes - a.sizeBytes || a.label.localeCompare(b.label))
  const output: TreemapRect[] = []
  layoutTreemapRecursive(filtered, { x: 0, y: 0, width: 100, height: 100 }, 0, output)
  return output
}
