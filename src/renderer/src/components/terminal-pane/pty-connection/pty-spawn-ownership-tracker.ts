import {
  beginPtySpawnOwnership,
  finishPtySpawnOwnership,
  hasPtySpawnOwnershipClaim,
  releasePtySpawnOwnership,
  type PtySpawnOwnershipAttempt
} from './pty-spawn-ownership'

export function createPtySpawnOwnershipTracker(paneKey: string | null) {
  const attempts = new Set<PtySpawnOwnershipAttempt>()

  return {
    begin(): PtySpawnOwnershipAttempt | null {
      const attempt = beginPtySpawnOwnership(paneKey)
      if (attempt) {
        attempts.add(attempt)
      }
      return attempt
    },
    finish(attempt: PtySpawnOwnershipAttempt | null): void {
      finishPtySpawnOwnership(attempt)
      if (attempt && !hasPtySpawnOwnershipClaim(attempt)) {
        attempts.delete(attempt)
      }
    },
    releaseAll(): void {
      for (const attempt of attempts) {
        releasePtySpawnOwnership(attempt)
      }
      attempts.clear()
    }
  }
}
