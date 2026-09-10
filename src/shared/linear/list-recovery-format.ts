export function linearListRecoveryInstructions(data: unknown): string[] {
  if (!data || typeof data !== 'object') {
    return []
  }
  const recovery = (data as { pageRecovery?: unknown }).pageRecovery
  if (recovery && typeof recovery === 'object' && 'continuation' in recovery) {
    const value = recovery.continuation
    if (typeof value === 'string' && value.length <= 65_536 && /^[A-Za-z0-9_-]+$/.test(value)) {
      return [`Continue with --workspace all --page-recovery ${value}`]
    }
  }
  const position = (data as { retryPosition?: unknown }).retryPosition
  if (position && typeof position === 'object') {
    const { workspaceId, cursor } = position as { workspaceId?: unknown; cursor?: unknown }
    if (typeof workspaceId === 'string' && workspaceId.length <= 2048) {
      return [
        `Retry workspace: ${JSON.stringify(workspaceId)}${typeof cursor === 'string' && cursor.length <= 4096 ? `; cursor: ${JSON.stringify(cursor)}` : '; start position'}`
      ]
    }
  }
  return []
}
