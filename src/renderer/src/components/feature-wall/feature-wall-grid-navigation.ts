export type FeatureWallNavigationKey =
  | 'ArrowLeft'
  | 'ArrowRight'
  | 'ArrowUp'
  | 'ArrowDown'
  | 'Home'
  | 'End'

export function getFeatureWallGridNavigationTarget(args: {
  currentIndex: number
  key: FeatureWallNavigationKey
  tileCount: number
  columnCount: number
}): number {
  const { currentIndex, key, tileCount } = args
  const columnCount = Math.max(1, Math.min(args.columnCount, tileCount))

  if (tileCount <= 0 || currentIndex < 0 || currentIndex >= tileCount) {
    return currentIndex
  }

  switch (key) {
    case 'Home':
      return 0
    case 'End':
      return tileCount - 1
    case 'ArrowLeft':
      if (currentIndex % columnCount === 0) {
        return currentIndex
      }
      return currentIndex - 1
    case 'ArrowRight': {
      const next = currentIndex + 1
      if (
        next >= tileCount ||
        Math.floor(next / columnCount) !== Math.floor(currentIndex / columnCount)
      ) {
        return currentIndex
      }
      return next
    }
    case 'ArrowUp': {
      const next = currentIndex - columnCount
      return next >= 0 ? next : currentIndex
    }
    case 'ArrowDown': {
      const next = currentIndex + columnCount
      return next < tileCount ? next : currentIndex
    }
  }
}
