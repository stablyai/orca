import type { Space } from '../../../shared/types'

export function getIndexedSpace(spaces: readonly Space[], index: number): Space | null {
  return spaces[index] ?? null
}

export function getAdjacentSpace(
  spaces: readonly Space[],
  activeSpaceId: string,
  direction: 'next' | 'previous'
): Space | null {
  const activeIndex = spaces.findIndex((space) => space.id === activeSpaceId)
  if (activeIndex < 0 || spaces.length <= 1) {
    return null
  }
  // Why: the pager is a loop — swiping past either end already wraps, so the shortcuts must too.
  // The pager animates the wrap by strip position, so next-from-last slides back to the leftmost.
  const step = direction === 'next' ? 1 : -1
  return spaces[(activeIndex + step + spaces.length) % spaces.length]
}
