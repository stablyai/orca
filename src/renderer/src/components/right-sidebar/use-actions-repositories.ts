import { useCallback, useEffect, useState } from 'react'
import { useAppStore } from '@/store'
import { actionsCandidateRepos, actionsRepoProbeKey } from './actions-repositories'
import { fetchActionsRepository } from '@/store/github/actions-requests'
import { isFolderRepo } from '../../../../shared/repo-kind'
import type { Repo } from '../../../../shared/repo-types'
import type { GitHubRepositoryIdentity } from '../../../../shared/github/pull-request-types'

export type ActionsRepositoryOption = { repo: Repo; repository: GitHubRepositoryIdentity }
const probes = new Map<
  string,
  {
    expiresAt: number
    promise: Promise<GitHubRepositoryIdentity | null>
    repository?: GitHubRepositoryIdentity | null
  }
>()

/** Probe registered repository identities with account/host-scoped caching and discard stale generations. */
export function useActionsRepositories(
  workspaceId: string | null,
  selectedRepoIds?: ReadonlySet<string>
) {
  const candidates = useCallback(
    (state: ReturnType<typeof useAppStore.getState>): Repo[] =>
      selectedRepoIds
        ? state.repos.filter((repo) => selectedRepoIds.has(repo.id) && !isFolderRepo(repo))
        : actionsCandidateRepos(state, workspaceId),
    [selectedRepoIds, workspaceId]
  )
  const key = useAppStore((state) => JSON.stringify(candidates(state).map(actionsRepoProbeKey)))
  const [result, setResult] = useState<{
    key: string
    options: ActionsRepositoryOption[]
    error: string | null
    loading: boolean
  }>({ key: '', options: [], error: null, loading: true })
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    let live = true
    setResult({ key, options: [], error: null, loading: true })
    const currentCandidates = candidates(useAppStore.getState())
    void Promise.all(
      currentCandidates.map(async (repo) => {
        const probeKey = actionsRepoProbeKey(repo)
        let probe = probes.get(probeKey)
        if (!probe || probe.expiresAt < Date.now() || retry) {
          const promise = fetchActionsRepository(useAppStore.getState(), {
            repoId: repo.id,
            repoPath: repo.path
          })
          probe = { expiresAt: Date.now() + 60_000, promise }
          probes.set(probeKey, probe)
          while (probes.size > 128) {
            const oldest = probes.keys().next().value
            if (oldest !== undefined) {
              probes.delete(oldest)
            }
          }
        }
        try {
          const repository = await probe.promise
          probe.repository = repository
          return { repo, repository, error: null }
        } catch (error) {
          probes.delete(probeKey)
          return {
            repo,
            repository: null,
            error: error instanceof Error ? error.message : String(error)
          }
        }
      })
    ).then((entries) => {
      if (!live) {
        return
      }
      setResult({
        key,
        options: entries.flatMap((entry) =>
          entry.repository ? [{ repo: entry.repo, repository: entry.repository }] : []
        ),
        error: entries.find((entry) => entry.error)?.error ?? null,
        loading: false
      })
    })
    return () => {
      live = false
    }
  }, [key, retry, candidates])
  return {
    available:
      result.key !== key || result.loading
        ? candidates(useAppStore.getState()).some(
            (repo) => probes.get(actionsRepoProbeKey(repo))?.repository !== null
          )
        : result.options.length > 0 || Boolean(result.error),
    options: result.key === key ? result.options : [],
    loading: result.key !== key || result.loading,
    error: result.key === key ? result.error : null,
    /** Start a new repository probe generation so results from the previous attempt cannot replace it. */
    retry: () => setRetry((value) => value + 1)
  }
}
