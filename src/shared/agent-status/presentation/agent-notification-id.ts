export type BuildAgentNotificationIdArgs = {
  worktreeId?: string | null
  paneKey?: string | null
  stateStartedAt?: number | null
}

export function buildAgentNotificationId({
  worktreeId,
  paneKey,
  stateStartedAt
}: BuildAgentNotificationIdArgs): string | null {
  if (!worktreeId || !paneKey || typeof stateStartedAt !== 'number') {
    return null
  }
  if (!Number.isFinite(stateStartedAt)) {
    return null
  }

  return [
    'agent',
    encodeURIComponent(worktreeId),
    encodeURIComponent(paneKey),
    String(Math.trunc(stateStartedAt))
  ].join(':')
}
