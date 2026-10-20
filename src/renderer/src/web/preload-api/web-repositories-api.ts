import type { PreloadApi } from '../../../../preload/api-types'
import { legacyBaseRefSearchResult } from '../../../../shared/base-ref-search-result'
import type { Repo } from '../../../../shared/repo-types'
import { keepRequestedRepositoryAddScriptPreview } from '../../../../shared/repository-add-script-route'
import type {
  RepoWithRepositoryAddScriptPreview,
  RepositoryAddScriptRequest
} from '../../../../shared/repository-add-script-types'
import { getDefaultCreateProjectParent } from '@/components/sidebar/create-project-defaults'
import {
  callRuntimeResult,
  callRuntimeResultWithOwner,
  withRuntimeRepoMutationOwner,
  withRuntimeRepoOwner
} from './web-runtime-calls'
import { invalidateRuntimeWorktreeCaches } from './web-runtime-session'
import { noopUnsubscribe } from './web-storage'
import {
  createWebRepositoryAddScriptApi,
  resolveWebRepositoryAddScriptRequest
} from './web-repository-add-script'

type CloneArgs = { url: string; destination: string }

// Why overloads: only an opted-in clone returns the wrapped shape; every existing caller gets a bare Repo.
function cloneRepoOnRuntime(
  args: CloneArgs & { repositoryAddScriptPreview: RepositoryAddScriptRequest }
): Promise<RepoWithRepositoryAddScriptPreview>
function cloneRepoOnRuntime(args: CloneArgs): Promise<Repo>
async function cloneRepoOnRuntime(
  args: CloneArgs & { repositoryAddScriptPreview?: RepositoryAddScriptRequest }
): Promise<Repo | RepoWithRepositoryAddScriptPreview> {
  invalidateRuntimeWorktreeCaches()
  const request = await resolveWebRepositoryAddScriptRequest(args.repositoryAddScriptPreview)
  const owned = await callRuntimeResultWithOwner<RepoWithRepositoryAddScriptPreview>(
    'repo.clone',
    {
      url: args.url,
      destination: args.destination,
      ...(request ? { repositoryAddScriptPreview: request } : {})
    },
    10 * 60_000
  )
  const repo = withRuntimeRepoOwner(owned.result.repo, owned.hostId)
  if (!args.repositoryAddScriptPreview) {
    return repo
  }
  return keepRequestedRepositoryAddScriptPreview(
    { ...owned.result, repo },
    args.repositoryAddScriptPreview.hostId
  )
}

function withRequestedPreview(
  result: RepoWithRepositoryAddScriptPreview | { error: string },
  requested: RepositoryAddScriptRequest | undefined
): RepoWithRepositoryAddScriptPreview | { error: string } {
  return requested && 'repo' in result
    ? keepRequestedRepositoryAddScriptPreview(result, requested.hostId)
    : result
}

export function createReposApi(): NonNullable<Partial<PreloadApi>['repos']> {
  return {
    list: async () => {
      const owned = await callRuntimeResultWithOwner<{ repos: Repo[] }>('repo.list')
      return owned.result.repos.map((repo) => withRuntimeRepoOwner(repo, owned.hostId))
    },
    add: async ({ path, kind, displayName, repositoryAddScriptPreview }) => {
      invalidateRuntimeWorktreeCaches()
      const request = await resolveWebRepositoryAddScriptRequest(repositoryAddScriptPreview)
      const owned = await callRuntimeResultWithOwner<
        RepoWithRepositoryAddScriptPreview | { error: string }
      >('repo.add', {
        path,
        kind,
        displayName,
        ...(request ? { repositoryAddScriptPreview: request } : {})
      })
      return withRequestedPreview(
        withRuntimeRepoMutationOwner(owned.result, owned.hostId),
        repositoryAddScriptPreview
      )
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
    clone: cloneRepoOnRuntime,
    cloneAbort: () => Promise.resolve(),
    create: async ({ parentPath, name, kind, repositoryAddScriptPreview }) => {
      invalidateRuntimeWorktreeCaches()
      const request = await resolveWebRepositoryAddScriptRequest(repositoryAddScriptPreview)
      const owned = await callRuntimeResultWithOwner<
        RepoWithRepositoryAddScriptPreview | { error: string }
      >('repo.create', {
        parentPath,
        name,
        kind,
        ...(request ? { repositoryAddScriptPreview: request } : {})
      })
      return withRequestedPreview(
        withRuntimeRepoMutationOwner(owned.result, owned.hostId),
        repositoryAddScriptPreview
      )
    },
    ...createWebRepositoryAddScriptApi(),
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
