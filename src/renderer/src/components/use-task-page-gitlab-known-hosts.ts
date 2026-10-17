import { useCallback, useEffect, useMemo, useReducer, useState } from 'react'
import { gitLabApiFor } from '@/runtime/gitlab-owner-api'
import { getRepoExecutionHostId, normalizeHostPart } from '../../../shared/execution-host'
import type { Repo } from '../../../shared/repo-types'
import { needsGitLabKnownHostsForGitHubMatch } from '../../../shared/task-source-repo-host-match'
import type { GitLabKnownHostsLookup } from './task-page-source-repo-scope'
import { gitLabTaskRepoSelector } from './task-page-source-context'

// Why: main caches glab's hosts per execution context for the whole session, so one
// answer per repo also serves every later visit to the Tasks page.
const knownHostsByRepoKey = new Map<string, readonly string[]>()
const inFlightByRepoKey = new Map<string, Promise<readonly string[] | null>>()
let knownHostsCacheVersion = 0

// Why the connection: a paired server's twins share its host and differ only by nested SSH target.
function knownHostsRepoKey(repo: Repo): string {
  return `${getRepoExecutionHostId(repo)}\0${normalizeHostPart(repo.connectionId) ?? ''}\0${repo.id}`
}

function loadGitLabKnownHosts(repo: Repo): Promise<readonly string[] | null> {
  const key = knownHostsRepoKey(repo)
  const inFlight = inFlightByRepoKey.get(key)
  if (inFlight) {
    return inFlight
  }
  const selector = gitLabTaskRepoSelector(repo)
  const request = gitLabApiFor(selector)
    .knownHosts(selector)
    .then((hosts) => {
      knownHostsByRepoKey.set(key, hosts)
      knownHostsCacheVersion += 1
      return hosts
    })
    // Why: a failure stays uncached so a later visit asks again once the host recovers.
    .catch(() => null)
    .finally(() => inFlightByRepoKey.delete(key))
  inFlightByRepoKey.set(key, request)
  return request
}

/** @internal - exposed for tests only */
export function _resetTaskPageGitLabKnownHostsCache(): void {
  knownHostsByRepoKey.clear()
  inFlightByRepoKey.clear()
  knownHostsCacheVersion += 1
}

/** Asks only for repos whose GitHub verdict depends on glab's hosts. */
export function useTaskPageGitLabKnownHosts(
  repos: readonly Repo[],
  enabled: boolean
): GitLabKnownHostsLookup {
  const [, rerender] = useReducer((count: number) => count + 1, 0)
  // Why: a failed lookup must not hold its repo pending; it is placed as if glab knew no hosts.
  const [failedRepoKeys, setFailedRepoKeys] = useState<ReadonlySet<string>>(() => new Set())
  const cacheVersion = knownHostsCacheVersion
  const missingRepos = useMemo(
    () =>
      enabled
        ? repos.filter(
            (repo) =>
              needsGitLabKnownHostsForGitHubMatch(repo) &&
              !knownHostsByRepoKey.has(knownHostsRepoKey(repo))
          )
        : [],
    // eslint-disable-next-line react-hooks/exhaustive-deps -- cacheVersion marks writes to the module cache read here.
    [enabled, repos, cacheVersion]
  )
  const missingReposKey = missingRepos.map(knownHostsRepoKey).join('|')
  useEffect(() => {
    let cancelled = false
    for (const repo of missingRepos) {
      void loadGitLabKnownHosts(repo).then((hosts) => {
        if (cancelled) {
          return
        }
        if (hosts) {
          rerender()
          return
        }
        setFailedRepoKeys((previous) => new Set(previous).add(knownHostsRepoKey(repo)))
      })
    }
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- missingReposKey names every repo in missingRepos; the array is rebuilt on unrelated repo updates.
  }, [missingReposKey])
  return useCallback(
    (repo: Repo) => {
      const key = knownHostsRepoKey(repo)
      return knownHostsByRepoKey.get(key) ?? (failedRepoKeys.has(key) ? [] : undefined)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- cacheVersion marks writes to the module cache this lookup reads.
    [failedRepoKeys, cacheVersion]
  )
}
