import type { PreloadApi } from '../../../../preload/api-types'
import { legacyBaseRefSearchResult } from '../../../../shared/base-ref-search-result'
import type { Repo } from '../../../../shared/repo-types'
import { getDefaultCreateProjectParent } from '@/components/sidebar/create-project-defaults'
import {
  callRuntimeResult,
  callRuntimeResultWithOwner,
  withRuntimeRepoMutationOwner,
  withRuntimeRepoOwner
} from './web-runtime-calls'
import { invalidateRuntimeWorktreeCaches } from './web-runtime-session'
import { noopUnsubscribe } from './web-storage'

export function createReposApi(): NonNullable<Partial<PreloadApi>['repos']> {
  return {
    list: async () => {
      const owned = await callRuntimeResultWithOwner<{ repos: Repo[] }>('repo.list')
      return owned.result.repos.map((repo) => withRuntimeRepoOwner(repo, owned.hostId))
    },
    // A WSL move is a desktop's own; a paired web client never holds the retained local rows.
    listWslMoved: async () => [],
    add: async ({ path, kind, displayName }) => {
      invalidateRuntimeWorktreeCaches()
      const owned = await callRuntimeResultWithOwner<{ repo: Repo } | { error: string }>(
        'repo.add',
        { path, kind, displayName }
      )
      return withRuntimeRepoMutationOwner(owned.result, owned.hostId)
    },
    // Why: host-scoped forget targets a desktop-owned SSH host; a paired web client has one runtime and no ghost-host state.
    removeForHost: () => {
      throw new Error('Forgetting a host is unavailable in paired web clients.')
    },
    reorder: async ({ orderedIds }) => callRuntimeResult('repo.reorder', { orderedIds }),
    // Why: this persists desktop-owned local/SSH rows; paired web clients own one runtime and use repo.reorder directly.
    reorderForHost: async () => {
      throw new Error('Host-scoped project reordering is unavailable in paired web clients.')
    },
    update: async ({ repoId, updates }) => {
      const owned = await callRuntimeResultWithOwner<{ repo: Repo }>('repo.update', {
        repo: repoId,
        updates
      })
      return withRuntimeRepoOwner(owned.result.repo, owned.hostId)
    },
    pickFolder: () => Promise.resolve(null),
    pickFolders: () => Promise.resolve([]),
    pickDirectory: () => Promise.resolve(null),
    clone: async ({ url, destination }) => {
      invalidateRuntimeWorktreeCaches()
      const owned = await callRuntimeResultWithOwner<{ repo: Repo }>(
        'repo.clone',
        { url, destination },
        10 * 60_000
      )
      return withRuntimeRepoOwner(owned.result.repo, owned.hostId)
    },
    cloneAbort: () => Promise.resolve(),
    create: async ({ parentPath, name, kind }) => {
      invalidateRuntimeWorktreeCaches()
      const owned = await callRuntimeResultWithOwner<{ repo: Repo } | { error: string }>(
        'repo.create',
        { parentPath, name, kind }
      )
      return withRuntimeRepoMutationOwner(owned.result, owned.hostId)
    },
    isGitAvailable: async () =>
      (await callRuntimeResult<{ available: boolean }>('repo.gitAvailable')).available,
    getDefaultCreateProjectParent: async () => {
      const result = await callRuntimeResult<{ resolvedPath: string }>('files.browseServerDir', {
        path: '~'
      })
      return getDefaultCreateProjectParent(result.resolvedPath)
    },
    onCloneProgress: () => noopUnsubscribe,
    getBaseRefDefault: async ({ repoId }) =>
      callRuntimeResult('repo.baseRefDefault', { repo: repoId }),
    searchBaseRefs: async ({ repoId, query, limit }) =>
      (
        await callRuntimeResult<{ refs: string[] }>('repo.searchRefs', {
          repo: repoId,
          query,
          limit
        })
      ).refs,
    searchBaseRefDetails: async ({ repoId, query, limit }) => {
      const result = await callRuntimeResult<{
        refs: string[]
        refDetails?: { refName: string; localBranchName: string }[]
      }>('repo.searchRefs', {
        repo: repoId,
        query,
        limit
      })
      return result.refDetails ?? result.refs.map(legacyBaseRefSearchResult)
    },
    onChanged: () => noopUnsubscribe
  }
}
