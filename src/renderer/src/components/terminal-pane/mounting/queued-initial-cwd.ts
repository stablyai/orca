export function resolveQueuedInitialCwd(
  queuedInitialCwd: string | null | undefined,
  consumeTabInitialCwd: () => string | null,
  defaultTabCwd: string
): { queuedInitialCwd: string | null; startupCwd: string } {
  const nextQueuedInitialCwd =
    queuedInitialCwd === undefined ? consumeTabInitialCwd() : queuedInitialCwd
  return {
    queuedInitialCwd: nextQueuedInitialCwd,
    startupCwd: nextQueuedInitialCwd ?? defaultTabCwd
  }
}

export function clearQueuedInitialCwdAfterFirstPane(
  queuedInitialCwd: string | null | undefined,
  defaultTabCwd: string,
  currentPtyCwd: string
): { queuedInitialCwd: string | null | undefined; ptyCwd: string } {
  if (!queuedInitialCwd) {
    return { queuedInitialCwd, ptyCwd: currentPtyCwd }
  }
  return { queuedInitialCwd: null, ptyCwd: defaultTabCwd }
}
