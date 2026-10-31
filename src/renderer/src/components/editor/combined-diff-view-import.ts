import type {
  CombinedDiffExtentItem,
  CombinedDiffItemAnchor,
  CombinedDiffViewImport
} from './combined-diff-extent'

export function getCombinedDiffRestorationIndex(
  state: CombinedDiffViewImport | null,
  anchor: CombinedDiffItemAnchor | null,
  items: readonly CombinedDiffExtentItem[],
  indices: ReadonlyMap<CombinedDiffItemAnchor['key'], number>
): number | undefined {
  if (!state) {
    const index = anchor && indices.get(anchor.key)
    return index !== null && index !== undefined && items[index]?.settled === false
      ? index
      : undefined
  }
  if (state.anchor) {
    return indices.get(state.anchor.key)
  }
  return items.find((item) => item.end > state.scrollTop)?.index ?? items.at(-1)?.index
}

export function getCombinedDiffImportedPoint(
  state: CombinedDiffViewImport,
  items: readonly CombinedDiffExtentItem[],
  height: number,
  published: boolean
): { anchor: CombinedDiffItemAnchor | null; target: number; settled: boolean } | undefined {
  const saved = state.anchor
  const item =
    saved &&
    (items.find((item) => item.key === saved.key) ??
      items.find((item) => saved.fallbackKeys?.includes(String(item.key))))
  if (!items.length && !published) {
    return undefined
  }
  if (item && saved) {
    const offset = item.key === saved.key ? saved.offset : 0
    const settled = item.settled !== false
    const reachable = Math.min(item.size, offset)
    return {
      anchor: { key: item.key, offset: settled ? reachable : offset, gap: 0 },
      target: item.start + reachable,
      settled
    }
  }
  const max = Math.max(0, (items.at(-1)?.end ?? 0) - height)
  const targetItem = items.find((item) => item.end > state.scrollTop) ?? items.at(-1)
  const terminal = items.every((item) => item.settled !== false)
  const target = terminal || saved ? Math.min(max, state.scrollTop) : state.scrollTop
  return {
    anchor: null,
    target,
    settled: !!saved || terminal || (target <= max && targetItem?.settled !== false)
  }
}
