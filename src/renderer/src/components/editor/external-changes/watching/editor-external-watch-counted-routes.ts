export type Counted<T> = { value: T; count: number }

/** Per-path counted entries (such as the workspaces a watch reports for), dropping a path once its last entry goes. */
export function bumpCounted<T>(
  counts: Map<string, Map<string, Counted<T>>>,
  key: string,
  itemKey: string,
  value: T,
  delta: number
): void {
  const items = counts.get(key) ?? new Map<string, Counted<T>>()
  const item = items.get(itemKey) ?? { value, count: 0 }
  item.value = value
  item.count += delta
  if (item.count > 0) {
    items.set(itemKey, item)
  } else {
    items.delete(itemKey)
  }
  if (items.size > 0) {
    counts.set(key, items)
  } else {
    counts.delete(key)
  }
}
