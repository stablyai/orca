// List-navigation for the workflow rail. Replaced the prior grid helper when
// the modal switched from a 12-tile grid to a workflow split view.

export type FeatureWallRailNavigationKey = 'ArrowUp' | 'ArrowDown' | 'Home' | 'End'

export function getFeatureWallRailNavigationTarget(args: {
  currentIndex: number
  key: FeatureWallRailNavigationKey
  itemCount: number
}): number {
  const { currentIndex, key, itemCount } = args

  if (itemCount <= 0 || currentIndex < 0 || currentIndex >= itemCount) {
    return currentIndex
  }

  switch (key) {
    case 'Home':
      return 0
    case 'End':
      return itemCount - 1
    case 'ArrowUp':
      return currentIndex > 0 ? currentIndex - 1 : currentIndex
    case 'ArrowDown':
      return currentIndex < itemCount - 1 ? currentIndex + 1 : currentIndex
  }
}
