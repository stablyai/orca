export type ListItemNumberStore<Item> = {
  read: (item: Item) => unknown
  write: (item: Item, typed: number) => void
}

/** Chat keeps each typed list number ("4." is step 4), but a list that repeats one number
 *  (1. 1. 1.) counts up from it as Markdown does. Call as each item opens, last in `children`. */
export function keepTypedListItemNumber<Item>(
  list: { start?: number | null; children: Item[] },
  typed: number,
  store: ListItemNumberStore<Item>
): void {
  const item = list.children.at(-1)
  const previous = list.children.at(-2)
  const start = list.start ?? 1
  const keeping = previous !== undefined && store.read(previous) !== undefined
  if (item === undefined || (!keeping && typed === start)) {
    return
  }
  if (!keeping) {
    // The first different number: the repeated ones before it were typed too.
    for (const earlier of list.children.slice(0, -1)) {
      store.write(earlier, start)
    }
  }
  store.write(item, typed)
}
