import type { RepoSourceControlAiOverrides } from '../../../../../../shared/source-control-ai-types'
import { normalizeRepoSourceControlAiOverrides } from '../../../../../../shared/source-control-ai-repo-settings'
import { toSourceControlAiRepoUpdate } from '../../../../../../shared/source-control-ai-recipe-save'
import type { SourceControlAiRepoUpdate } from '../../../../../../shared/source-control-ai-recipe-save'

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

  // Return false for failed edits so callers can roll back; abandoned/no-op writes succeed to avoid errors after repo switches.
  const persistTransform = (
    transform: (base: RepoSourceControlAiOverrides) => RepoSourceControlAiOverrides
  ): Promise<boolean> => {
    // Pin repo identity when queued so navigation cannot apply transforms to another repo’s base.
    const repoIdForWrite = options.getRepoId()
    const run = chain
      .catch(() => undefined)
      .then(async (): Promise<boolean> => {
        if (options.getRepoId() !== repoIdForWrite) {
          return true
        }
        // Catch transform/conversion failures too; fire-and-forget callers rely on onError rather than rejected promises.
        try {
          const next = transform(options.getPersisted())
          if (JSON.stringify(next) === JSON.stringify(options.getPersisted())) {
            return true
          }
          const repoUpdate = toSourceControlAiRepoUpdate(next)
          const result = await options.updateRepo(repoIdForWrite, repoUpdate)
          // Successful old-repo writes must not seed the new repo’s local baseline.
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
    // Keep the chain nonrejecting so one failed write cannot block later writes.
    chain = run.then(() => undefined)
    return run
  }

  return { persistTransform }
}
