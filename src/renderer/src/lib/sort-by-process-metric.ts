/** Shared by the Resource Manager and Ports popovers so both sort identically. */

export type ProcessMetricSortOption = 'name' | 'cpu' | 'memory' | 'uptime'

/** `null`/`undefined` (no sample) always sorts last, regardless of direction. */
export function compareProcessMetricDesc(
  a: number | null | undefined,
  b: number | null | undefined
): number {
  const left = a ?? null
  const right = b ?? null
  if (left === null && right === null) {
    return 0
  }
  if (left === null) {
    return 1
  }
  if (right === null) {
    return -1
  }
  return right - left
}

export type ProcessMetricGetters<T> = {
  name: (item: T) => string
  cpu: (item: T) => number | null | undefined
  memory: (item: T) => number | null | undefined
  /** Seconds. For a group, pass the oldest member's uptime — summing ages makes no sense. */
  uptime: (item: T) => number | null | undefined
}

/** Sorts a copy of `items` by name (ascending) or cpu/memory/uptime (descending, biggest first). */
export function sortByProcessMetric<T>(
  items: readonly T[],
  sort: ProcessMetricSortOption,
  getters: ProcessMetricGetters<T>
): T[] {
  const copy = [...items]
  if (sort === 'cpu') {
    copy.sort((a, b) => compareProcessMetricDesc(getters.cpu(a), getters.cpu(b)))
  } else if (sort === 'memory') {
    copy.sort((a, b) => compareProcessMetricDesc(getters.memory(a), getters.memory(b)))
  } else if (sort === 'uptime') {
    copy.sort((a, b) => compareProcessMetricDesc(getters.uptime(a), getters.uptime(b)))
  } else {
    copy.sort((a, b) => getters.name(a).localeCompare(getters.name(b)))
  }
  return copy
}
