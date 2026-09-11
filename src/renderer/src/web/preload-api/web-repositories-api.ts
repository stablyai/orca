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
import { assertActiveEnvironment, invalidateRuntimeWorktreeCaches } from './web-runtime-session'
import { noopUnsubscribe } from './web-storage'

export function createReposApi(): NonNullable<Partial<PreloadApi>['repos']> {
  return {
    list: async () => {
      const owned = await callRuntimeResultWithOwner<{ repos: Repo[] }>('repo.list')
      return owned.result.repos.map((repo) => withRuntimeRepoOwner(repo, owned.hostId))
    },
    add: async ({ path, kind, displayName }) => {
      invalidateRuntimeWorktreeCaches()
      const owned = await callRuntimeResultWithOwner<{ repo: Repo } | { error: string }>(
        'repo.add',
        { path, kind, displayName }
      )
      return withRuntimeRepoMutationOwner(owned.result, owned.hostId)
    },
    remove: async ({ repoId }) => {
      await callRuntimeResult('repo.rm', { repo: repoId })
      invalidateRuntimeWorktreeCaches()
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
    cloneRemote: async () => {
      // Why: SSH relay cloning is owned by the desktop main process; paired web clients can't run that local IPC path.
      throw new Error('SSH clone is unavailable in paired web clients.')
    },
    createRemote: async () => {
      // Why: SSH relay project creation is owned by the desktop main process; paired web clients can't use local SSH IPC.
      throw new Error('Creating projects on SSH hosts is unavailable in paired web clients.')
    },
    cloneAbort: () => Promise.resolve(),
    addRemote: async ({ remotePath, displayName, kind }) => {
      invalidateRuntimeWorktreeCaches()
      const owned = await callRuntimeResultWithOwner<{ repo: Repo }>('repo.add', {
        path: remotePath,
        kind
      })
      const result = {
        repo: withRuntimeRepoOwner(owned.result.repo, owned.hostId)
      }
      if (!displayName) {
        return result
      }
      assertActiveEnvironment(owned.environmentId)
      return {
        repo: await createReposApi().update({
          repoId: result.repo.id,
          updates: { displayName }
        })
      }
    },
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
    getGitUsername: () => Promise.resolve(''),
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
