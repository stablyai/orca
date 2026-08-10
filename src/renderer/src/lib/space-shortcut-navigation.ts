import type { Space } from '../../../shared/types'

export function getIndexedSpace(spaces: readonly Space[], index: number): Space | null {
  return Number.isInteger(index) && index >= 0 ? (spaces[index] ?? null) : null
}

export function getAdjacentSpace(
  spaces: readonly Space[],
  activeSpaceId: string,
  direction: 'next' | 'previous'
): Space | null {
  const activeIndex = spaces.findIndex((space) => space.id === activeSpaceId)
  if (activeIndex < 0) {
    return null
  }
  const targetIndex = activeIndex + (direction === 'next' ? 1 : -1)
  return spaces[targetIndex] ?? null
}
