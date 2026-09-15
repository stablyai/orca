const surfaceIdsByProducerAttempt = new Map<string, ReadonlySet<string>>()

export function readActivationRecoveryFailureSurfaceIds(
  attemptId: string
): ReadonlySet<string> | undefined {
  return surfaceIdsByProducerAttempt.get(attemptId)
}

export function recordActivationRecoveryFailureSurfaceIds(
  attemptId: string,
  surfaceIds: ReadonlySet<string>
): void {
  surfaceIdsByProducerAttempt.set(attemptId, surfaceIds)
}

export function clearActivationRecoveryFailureSnapshots(attemptIds: readonly string[]): void {
  for (const attemptId of attemptIds) {
    surfaceIdsByProducerAttempt.delete(attemptId)
  }
}
