import type { DiffComment } from '../../../shared/diff-comment-types'
import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import {
  authorityKey,
  hostAuthorityFromOperationRoute,
  type HostAuthority
} from '../../../shared/host-authority'
import { resolveWorktreeExecutionHost } from '../../../shared/worktree-execution-host-resolution'
import { getIndexedRepoExecutionHostLookup } from '@/lib/repo-owner-index'
import type { Worktree } from '../../../shared/worktree/types'
import type { AppState } from './types'
import { findFolderWorkspaceOwner } from '@/lib/folder-workspace-runtime-owner'
import { namedHostForOwnerRef, resolveOwner } from '@/lib/resolve-owner'
import { resolveExactWorktreeRoute } from '@/lib/worktree-owner-route'
import { worktreeOwnerHostIds } from '@/lib/worktree-runtime-owner-index'
import type { WorktreeOperationRouteResolution } from '@/lib/worktree-operation-route'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import { selectWorktreesByRepo } from './workspace-record-selectors'

const EMPTY_DIFF_COMMENTS = Object.freeze([]) as unknown as DiffComment[]
export { EMPTY_DIFF_COMMENTS }

/** Every store field note ownership is resolved from; a write changing none of them changes no owner. */
export const DIFF_COMMENT_OWNER_INPUTS = [
  'worktreesByRepo',
  'detectedWorktreesByRepo',
  'repos',
  'folderWorkspaces',
  'projectGroups',
  'restoredRuntimeHostIdByWorkspaceSessionKey',
  'activeWorktreeId',
  'activeWorkspaceExecutionHostId',
  'settings',
  'runtimeEnvironments',
  'runtimeEnvironmentCatalogHydrated',
  'removedRuntimeEnvironmentIds'
] as const satisfies readonly (keyof AppState)[]

export type DiffCommentSelectorState = Pick<AppState, 'worktreesByRepo'> &
  Partial<Pick<AppState, (typeof DIFF_COMMENT_OWNER_INPUTS)[number]>>

/** Where a surface's content comes from: its server (`null` this app), or `undefined` for the selected copy. */
export type DiffCommentSource = { runtimeEnvironmentId?: string | null }

function authorityOfRoute(resolution: WorktreeOperationRouteResolution): HostAuthority | null {
  if (resolution.kind !== 'resolved') {
    return null
  }
  const authority = hostAuthorityFromOperationRoute(resolution.route)
  return authority === 'contradictory' ? null : authority
}

const rowAuthorityCache = new WeakMap<
  Worktree,
  { repos: DiffCommentSelectorState['repos']; authority: HostAuthority | null }
>()

/** An unstamped (legacy or this app's) row's host: the repo's sole owner, else this app when it has the repo. */
function unstampedRowHost(state: DiffCommentSelectorState, row: Worktree): ExecutionHostId | null {
  const repos = getIndexedRepoExecutionHostLookup(state.repos)
  const owner = resolveWorktreeExecutionHost(repos, { repoId: row.repoId })
  if (owner.kind === 'resolved') {
    return owner.hostId
  }
  return owner.reason === 'unknown' || repos.byHost(row.repoId, LOCAL_EXECUTION_HOST_ID)
    ? LOCAL_EXECUTION_HOST_ID
    : null
}

/**
 * A row's copy: its own stamps, or its repo's owner when it has none, plus repo proof of a server
 * proxying its SSH host. Null when the evidence disagrees, so the row matches no captured copy.
 */
function rowAuthority(state: DiffCommentSelectorState, row: Worktree): HostAuthority | null {
  const cached = rowAuthorityCache.get(row)
  if (cached && cached.repos === state.repos) {
    return cached.authority
  }
  const stamped = Boolean(row.hostId || row.runtimeOwnerEnvironmentId?.trim())
  const hostId = stamped ? row.hostId : unstampedRowHost(state, row)
  const authority =
    stamped || hostId
      ? authorityOfRoute(resolveExactWorktreeRoute(state, { ...row, hostId: hostId ?? undefined }))
      : null
  rowAuthorityCache.set(row, { repos: state.repos, authority })
  return authority
}

/** The listed rows of one copy; duplicates of it share notes, the last one winning as in the id index. */
export function findCopyRows(
  state: DiffCommentSelectorState,
  worktreeId: string,
  authority: HostAuthority
): Worktree[] {
  const key = authorityKey(authority)
  return (selectWorktreesByRepo(state)[getRepoIdFromWorktreeId(worktreeId)] ?? []).filter((row) => {
    if (row.id !== worktreeId) {
      return false
    }
    const own = rowAuthority(state, row)
    return own !== null && authorityKey(own) === key
  })
}

function distinctAuthority(
  authorities: readonly HostAuthority[]
): HostAuthority | 'ambiguous' | null {
  const keys = new Set(authorities.map(authorityKey))
  return keys.size > 1 ? 'ambiguous' : (authorities[0] ?? null)
}

/**
 * The copy a surface shows: the one its source or the selected host names, else the sole listed
 * copy. A host names a row by its own stamps or, for a server alias, by the server the repo
 * proves proxies it. With nothing listed, the qualifier's own route is the copy to wait for.
 */
export function resolveDiffCommentCopy(
  state: DiffCommentSelectorState,
  worktreeId: string,
  source: DiffCommentSource = {}
): HostAuthority | 'ambiguous' | null {
  const { runtimeEnvironmentId } = source
  const appOnly = runtimeEnvironmentId === null
  const fits = (authority: HostAuthority | null): authority is HostAuthority =>
    authority !== null && (!appOnly || authority.endpoint.kind === 'self')
  const rows = (selectWorktreesByRepo(state)[getRepoIdFromWorktreeId(worktreeId)] ?? []).filter(
    (row) => row.id === worktreeId
  )
  const host: ExecutionHostId | null = runtimeEnvironmentId
    ? toRuntimeExecutionHostId(runtimeEnvironmentId)
    : namedHostForOwnerRef(state, { workspaceId: worktreeId })
  if (!host) {
    return distinctAuthority(rows.map((row) => rowAuthority(state, row)).filter(fits))
  }
  const server = parseExecutionHostId(host)
  const environmentId = server?.kind === 'runtime' ? server.environmentId : null
  const named = rows.flatMap((row) => {
    const authority = rowAuthority(state, row)
    const byServer =
      authority?.endpoint.kind === 'environment' &&
      authority.endpoint.environmentId === environmentId
    return fits(authority) && (byServer || worktreeOwnerHostIds(row).includes(host))
      ? [authority]
      : []
  })
  if (named.length > 0) {
    return distinctAuthority(named)
  }
  const pending = environmentId
    ? resolveOwner(state, { workspaceId: worktreeId, hostId: host })
    : null
  const authority =
    pending?.kind === 'resolved'
      ? pending.owner
      : environmentId
        ? null
        : authorityOfRoute(
            resolveExactWorktreeRoute(state, {
              id: worktreeId,
              repoId: getRepoIdFromWorktreeId(worktreeId),
              hostId: host
            })
          )
  return fits(authority) ? authority : null
}

/** Notes of the copy's rows; undefined while it is not listed. */
export function readCopyNotes(rows: readonly Worktree[]): DiffComment[] | undefined {
  return rows.length > 0 ? (rows.at(-1)?.diffComments ?? EMPTY_DIFF_COMMENTS) : undefined
}

export function selectWorktreeDiffComments(
  state: DiffCommentSelectorState,
  worktreeId: string | null | undefined
): DiffComment[] | undefined {
  if (!worktreeId) {
    return undefined
  }
  const scope = parseWorkspaceKey(worktreeId)
  if (scope?.type === 'folder') {
    return findFolderWorkspaceOwner(state, scope.folderWorkspaceId)?.diffComments
  }
  // Only an identifiable copy shows notes; another copy's notes would invite writes to it.
  const copy = resolveDiffCommentCopy(state, worktreeId)
  return copy && copy !== 'ambiguous'
    ? readCopyNotes(findCopyRows(state, worktreeId, copy))
    : undefined
}

export function selectWorktreeDiffCommentsOrEmpty(
  state: Parameters<typeof selectWorktreeDiffComments>[0],
  worktreeId: string | null | undefined
): DiffComment[] {
  return selectWorktreeDiffComments(state, worktreeId) ?? EMPTY_DIFF_COMMENTS
}
