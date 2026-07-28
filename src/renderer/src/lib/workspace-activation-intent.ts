let latestWorkspaceActivationIntent = 0

export function beginWorkspaceActivationIntent(): number {
  return ++latestWorkspaceActivationIntent
}

export function isCurrentWorkspaceActivationIntent(intent: number): boolean {
  return intent === latestWorkspaceActivationIntent
}
