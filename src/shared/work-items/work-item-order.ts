// Main rows lack renderer-stamped repoId; require only number and sort newest-first like GitHub Issues.
export function sortWorkItemsByNumber<T extends { number: number }>(items: T[]): T[] {
  return [...items].sort((left, right) => right.number - left.number)
}
