/** Resolve the one tab introduced by the harness. Ambiguity would make the
 *  post-crash input oracle capable of targeting an unrelated restored tab. */
export function selectCreatedTabId(beforeTabIds, afterTabIds) {
  const before = new Set(beforeTabIds)
  const created = afterTabIds.filter((tabId) => !before.has(tabId))
  if (created.length !== 1) {
    throw new Error(`expected exactly one created terminal tab, found ${created.length}`)
  }
  return created[0]
}

/** The canary rejects a respawned shell; the PID additionally proves that input
 *  reached the exact survivor whose liveness was checked during the crash. */
export function reattachSentinelMatches(raw, expectedCanary, expectedShellPid) {
  const [pidPart, canaryPart, extraPart] = raw.trim().split('|')
  return (
    extraPart === undefined && canaryPart === expectedCanary && Number(pidPart) === expectedShellPid
  )
}
