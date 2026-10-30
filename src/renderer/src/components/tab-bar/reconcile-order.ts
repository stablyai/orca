/** Keep surviving stored order and append missing IDs in input type order. */
export function reconcileTabOrder(
  storedOrder: string[] | undefined,
  terminalIds: string[],
  editorIds: string[],
  browserIds: string[] = [],
  simulatorIds: string[] = [],
  agentSessionIds: string[] = [],
  agentsIds: string[] = []
): string[] {
  const validIds = new Set([
    ...terminalIds,
    ...editorIds,
    ...browserIds,
    ...simulatorIds,
    ...agentSessionIds,
    ...agentsIds
  ])
  // Deduplicate at the render boundary because persisted drop/move/hydration races can leave repeated React keys.
  const result: string[] = []
  const inResult = new Set<string>()
  for (const id of storedOrder ?? []) {
    if (validIds.has(id) && !inResult.has(id)) {
      result.push(id)
      inResult.add(id)
    }
  }
  for (const id of [
    ...terminalIds,
    ...editorIds,
    ...browserIds,
    ...simulatorIds,
    ...agentSessionIds,
    ...agentsIds
  ]) {
    if (!inResult.has(id)) {
      result.push(id)
      inResult.add(id)
    }
  }
  return result
}
