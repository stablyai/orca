/** APG toolbar keys for a vertical toolbar; null means the key is not a roving key. */
export function nextAppRailFocusIndex(key: string, current: number, count: number): number | null {
  if (count === 0) {
    return null
  }
  switch (key) {
    case 'ArrowDown':
      return (current + 1) % count
    case 'ArrowUp':
      return (current - 1 + count) % count
    case 'Home':
      return 0
    case 'End':
      return count - 1
    default:
      return null
  }
}
