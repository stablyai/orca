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

  // Why: split panes can share one retained model. If any
  // pane is currently reconciling prop content into that shared model, every
  // pane sees the echoed change event and must treat it as programmatic.
  return isApplyingProgrammaticContent || isProgrammaticContentSyncInFlight(modelKey)
}

export function resetProgrammaticContentSyncForTests(): void {
  programmaticContentSyncDepthByModelKey.clear()
}
