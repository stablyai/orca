/**
 * Reconcile stored tab bar order with the current set of tab IDs.
 * Keeps items that still exist in their stored positions, appends new items
 * at the end in their natural order (not grouped by type).
 */
export function reconcileTabOrder(
  storedOrder: string[] | undefined,
  terminalIds: string[],
  editorIds: string[],
  browserIds: string[] = [],
  notesIds: string[] = []
): string[] {
  const validIds = new Set([...terminalIds, ...editorIds, ...browserIds, ...notesIds])
  // Why: storedOrder is persisted group tab order and is mutated by many
  // codepaths (drop/move/reorder/hydrate). A stale or racey write can leave
  // the same tab id twice in the list, which surfaces as React's "two
  // children with the same key" warning when TabBar maps items to
  // SortableTab/EditorFileTab/BrowserTab. Dedupe at the render boundary so
  // the UI never produces duplicate keys regardless of store-side bugs.
  const result: string[] = []
  const inResult = new Set<string>()
  for (const id of storedOrder ?? []) {
    if (validIds.has(id) && !inResult.has(id)) {
      result.push(id)
      inResult.add(id)
    }
  }
  for (const id of [...terminalIds, ...editorIds, ...browserIds, ...notesIds]) {
    if (!inResult.has(id)) {
      result.push(id)
      inResult.add(id)
    }
  }
  return result
}
