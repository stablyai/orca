/**
 * Reconcile stored tab bar order with the current set of tab IDs.
 * Keeps items that still exist in their stored positions, appends new items
 * at the end in their natural order (not grouped by type).
 */
export function reconcileTabOrder(
  storedOrder: string[] | undefined,
  terminalIds: string[],
  editorIds: string[],
  browserIds: string[] = []
): string[] {
  const validIds = new Set([...terminalIds, ...editorIds, ...browserIds])
  const result: string[] = (storedOrder ?? []).filter((id) => validIds.has(id))
  const inResult = new Set(result)
  for (const id of [...terminalIds, ...editorIds, ...browserIds]) {
    if (!inResult.has(id)) {
      result.push(id)
      inResult.add(id)
    }
  }
  return result
}
