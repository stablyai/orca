export type CopyOnWriteRecord<T> = {
  /** The source until the first write, then the one clone every later write reuses. */
  read: () => Record<string, T>
  /** No-op for an absent key, so deleting nothing never clones. */
  delete: (key: string) => void
  set: (key: string, value: T) => void
}

/**
 * Lets a store patch touch a record only when it has something to change: an untouched
 * source keeps its identity, so identity-keyed selectors and persist gates stay quiet.
 */
export function copyOnWriteRecord<T>(source: Record<string, T>): CopyOnWriteRecord<T> {
  let next = source
  const mutable = (): Record<string, T> => {
    if (next === source) {
      next = { ...source }
    }
    return next
  }
  return {
    read: () => next,
    delete: (key) => {
      if (key in next) {
        delete mutable()[key]
      }
    },
    set: (key, value) => {
      mutable()[key] = value
    }
  }
}
