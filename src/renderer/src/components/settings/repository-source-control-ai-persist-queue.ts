import type { RepoSourceControlAiOverrides } from '../../../../shared/source-control-ai-types'
import { normalizeRepoSourceControlAiOverrides } from '../../../../shared/source-control-ai'
import { toSourceControlAiRepoUpdate } from '../../../../shared/source-control-ai-recipe-save'
import type { SourceControlAiRepoUpdate } from '../../../../shared/source-control-ai-recipe-save'

type PersistQueueOptions = {
  getRepoId: () => string
  getPersisted: () => RepoSourceControlAiOverrides
  setPersisted: (value: RepoSourceControlAiOverrides) => void
  updateRepo: (repoId: string, updates: SourceControlAiRepoUpdate) => void | Promise<boolean>
  isMounted: () => boolean
  onError: (message: string) => void
}

/** Serializes nested sourceControlAi writes so concurrent field updates cannot clobber each other. */
export function createRepoAiPersistQueue(options: PersistQueueOptions) {
  let chain: Promise<void> = Promise.resolve()

  // Resolves true when the write persisted, was a no-op, or was abandoned after a repo switch.
  // Resolves false when updateRepo failed. Why: callers keep optimistic UI honest (roll back a field /
  // leave a recipe row dirty); a queue that swallowed failures made `await` always look like success
  // and silently dropped edits. Abandoned writes return true so a repo switch does not surface a
  // spurious error on the newly selected repo.
  const persistTransform = (
    transform: (base: RepoSourceControlAiOverrides) => RepoSourceControlAiOverrides
  ): Promise<boolean> => {
    // Why: pin the target at schedule time — if the settings pane switches repos before this
    // transform runs, applying it against the new repo's base would corrupt that repo's overrides.
    const repoIdForWrite = options.getRepoId()
    const run = chain
      .catch(() => undefined)
      .then(async (): Promise<boolean> => {
        if (options.getRepoId() !== repoIdForWrite) {
          return true
        }
        // Why: keep transform()/toSourceControlAiRepoUpdate() inside the try so a throw there
        // still routes through onError instead of becoming an unhandled rejection for fire-and-forget callers.
        try {
          const next = transform(options.getPersisted())
          if (JSON.stringify(next) === JSON.stringify(options.getPersisted())) {
            return true
          }
          const repoUpdate = toSourceControlAiRepoUpdate(next)
          const result = await options.updateRepo(repoIdForWrite, repoUpdate)
          // Why: even a successful write for the previous repo must not update local persisted state
          // once the UI is showing a different repo (would seed the wrong base for later edits).
          if (!options.isMounted() || options.getRepoId() !== repoIdForWrite) {
            return true
          }
          if (result === false) {
            options.onError('Failed to save Source Control AI settings.')
            return false
          }
          const savedValue =
            repoUpdate.sourceControlAi === null
              ? {}
              : (normalizeRepoSourceControlAiOverrides(repoUpdate.sourceControlAi) ?? {})
          options.setPersisted(savedValue)
          return true
        } catch {
          if (options.isMounted() && options.getRepoId() === repoIdForWrite) {
            options.onError('Failed to save Source Control AI settings.')
          }
          return false
        }
      })
    // Keep the shared chain a never-rejecting Promise<void> so one write's failure can't block the next.
    chain = run.then(() => undefined)
    return run
  }

  return { persistTransform }
}
