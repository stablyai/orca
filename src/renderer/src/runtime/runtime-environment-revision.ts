const revisionByEnvironmentId = new Map<string, number>()

export function replaceRuntimeEnvironmentRevisions(
  environments: readonly { id: string; createdAt: number; pairingRevision?: number }[]
): void {
  revisionByEnvironmentId.clear()
  for (const environment of environments) {
    revisionByEnvironmentId.set(
      environment.id,
      environment.pairingRevision ?? environment.createdAt
    )
  }
}

export function getRuntimeEnvironmentRevision(environmentId: string): number | undefined {
  return revisionByEnvironmentId.get(environmentId)
}

export function captureRuntimeEnvironmentRequestRevision(
  environmentId: string,
  expectedRevision?: number
): number | undefined {
  // Why: callers capture before awaits so a same-id re-pair cannot retarget their request.
  return expectedRevision ?? getRuntimeEnvironmentRevision(environmentId)
}
