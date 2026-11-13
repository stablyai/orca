// Repo-scope write check for the S4-b secret request card (use-secret-request-card.ts), split out to keep that
// hook under the file-length limit.
/** Whether this person can write the workspace repo's scope; asked once per repo per session. */
const repoWriteCache = new Map<string, Promise<boolean>>()

export function canWriteRepo(repoKey: string): Promise<boolean> {
  let pending = repoWriteCache.get(repoKey)
  if (!pending) {
    const api = window.api.cloudSecrets
    pending = api
      ? api.effective({ repo: repoKey }).then(
          (result) => result.ok && result.value.caller.canWrite.repo,
          () => false
        )
      : Promise.resolve(false)
    // A failed read is retried next time rather than cached as "no".
    void pending.then((value) => {
      if (!value) {
        repoWriteCache.delete(repoKey)
      }
    })
    repoWriteCache.set(repoKey, pending)
  }
  return pending
}

export function resetSecretRequestCardCachesForTests(): void {
  repoWriteCache.clear()
}
