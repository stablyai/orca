const programmaticContentSyncDepthByModelKey = new Map<string, number>()

export function beginProgrammaticContentSync(modelKey: string): void {
  programmaticContentSyncDepthByModelKey.set(
    modelKey,
    (programmaticContentSyncDepthByModelKey.get(modelKey) ?? 0) + 1
  )
}

export function endProgrammaticContentSync(modelKey: string): void {
  const depth = programmaticContentSyncDepthByModelKey.get(modelKey) ?? 0
  if (depth <= 1) {
    programmaticContentSyncDepthByModelKey.delete(modelKey)
    return
  }
  programmaticContentSyncDepthByModelKey.set(modelKey, depth - 1)
}

export function isProgrammaticContentSyncInFlight(modelKey: string): boolean {
  return (programmaticContentSyncDepthByModelKey.get(modelKey) ?? 0) > 0
}

export function shouldIgnoreMonacoContentChange(args: {
  modelKey: string
  isApplyingProgrammaticContent: boolean
}): boolean {
  const { modelKey, isApplyingProgrammaticContent } = args

  // Every pane sharing a retained model must ignore programmatic update echoes from any sibling.
  return isApplyingProgrammaticContent || isProgrammaticContentSyncInFlight(modelKey)
}

export function resetProgrammaticContentSyncForTests(): void {
  programmaticContentSyncDepthByModelKey.clear()
}
