const programmaticContentSyncDepthByFilePath = new Map<string, number>()

export function beginProgrammaticContentSync(filePath: string): void {
  programmaticContentSyncDepthByFilePath.set(
    filePath,
    (programmaticContentSyncDepthByFilePath.get(filePath) ?? 0) + 1
  )
}

export function endProgrammaticContentSync(filePath: string): void {
  const depth = programmaticContentSyncDepthByFilePath.get(filePath) ?? 0
  if (depth <= 1) {
    programmaticContentSyncDepthByFilePath.delete(filePath)
    return
  }
  programmaticContentSyncDepthByFilePath.set(filePath, depth - 1)
}

export function isProgrammaticContentSyncInFlight(filePath: string): boolean {
  return (programmaticContentSyncDepthByFilePath.get(filePath) ?? 0) > 0
}

export function shouldIgnoreMonacoContentChange(args: {
  filePath: string
  isApplyingProgrammaticContent: boolean
}): boolean {
  const { filePath, isApplyingProgrammaticContent } = args

  // Why: split panes can share one retained Monaco model by file path. If any
  // pane is currently reconciling prop content into that shared model, every
  // pane sees the echoed change event and must treat it as programmatic.
  return isApplyingProgrammaticContent || isProgrammaticContentSyncInFlight(filePath)
}

export function resetProgrammaticContentSyncForTests(): void {
  programmaticContentSyncDepthByFilePath.clear()
}
