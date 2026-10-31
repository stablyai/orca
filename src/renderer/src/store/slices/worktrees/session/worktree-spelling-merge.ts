import type { AppState } from '../../../types'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import type { DetectedWorktreeListResult } from '../../../../../../shared/worktree/types'
import { getRepoIdFromWorktreeId, worktreeIdentityKey } from '../../../../../../shared/worktree/id'
import { buildHostIdByWorktreeId } from '@/lib/workspace-session-host-persistence'
import {
  getOpenFileExecutionHostId,
  hasOpenFileExecutionHostEvidence
} from '@/lib/unified-tab-host-ownership'
import { rememberWorktreeRename } from '@/lib/worktree-rename-grace'
import { isExecutionHostAliasForWorktree } from '@/lib/worktree-execution-host-alias'
import {
  selectDetectedWorktreesByRepo,
  selectWorktreesByRepo
} from '../../../workspace-record-selectors'
import { worktreeHostMatchOptions, worktreeMatchesHost } from '../listing/worktree-host-ownership'
import {
  buildWorktreeRenameState,
  WORKTREE_ID_KEYED_MAP_KEYS
} from './worktree-identity-rename-state'

const SESSION_MAPS = [
  ...WORKTREE_ID_KEYED_MAP_KEYS,
  'tabsByWorktree',
  'unifiedTabsByWorktree',
  'browserTabsByWorktree',
  'groupsByWorktree',
  'layoutByWorktree',
  'activeGroupIdByWorktree',
  'activeTabIdByWorktree',
  'activeFileIdByWorktree',
  'activeBrowserTabIdByWorktree',
  'activeTabTypeByWorktree',
  'tabBarOrderByWorktree'
] as const satisfies readonly (keyof AppState)[]

/** Reconcile path spelling before publishing a listing; catalog owners fence every move. */
export function mergeListedWorktreeSpellings(
  state: AppState,
  repoId: string,
  hostId: ExecutionHostId,
  detected: DetectedWorktreeListResult
): Partial<AppState> {
  const ids = new Set(SESSION_MAPS.flatMap((key) => Object.keys(state[key] ?? {})))
  for (const file of state.openFiles) ids.add(file.worktreeId)
  const listedByIdentity = new Map(
    detected.worktrees.map((row) => [worktreeIdentityKey(row.id), row])
  )
  const rows = [
    ...(selectWorktreesByRepo(state)[repoId] ?? []),
    ...(selectDetectedWorktreesByRepo(state)[repoId]?.worktrees ?? [])
  ]
  const hostForId = buildHostIdByWorktreeId(state)
  const matchOptions = worktreeHostMatchOptions(state, repoId, hostId)
  let patch: Partial<AppState> = {}
  let current = state
  for (const oldId of ids) {
    if (getRepoIdFromWorktreeId(oldId) !== repoId) continue
    const listed = listedByIdentity.get(worktreeIdentityKey(oldId))
    if (!listed || listed.id === oldId) continue
    const newId = listed.id
    // A raw-id rename cannot move a co-claimant's state; those partitions remain separate.
    if (
      [oldId, newId].some(
        (id) =>
          !isExecutionHostAliasForWorktree(hostForId(id), { ...listed, hostId }) ||
          rows.some((row) => row.id === id && !worktreeMatchesHost(row, hostId, matchOptions)) ||
          current.openFiles.some(
            (file) =>
              file.worktreeId === id &&
              hasOpenFileExecutionHostEvidence(file) &&
              !isExecutionHostAliasForWorktree(getOpenFileExecutionHostId(file), {
                ...listed,
                hostId
              })
          ) ||
          (current.unifiedTabsByWorktree[id] ?? []).some(
            (tab) =>
              tab.executionHostId &&
              !isExecutionHostAliasForWorktree(tab.executionHostId, { ...listed, hostId })
          )
      )
    )
      continue
    const sourceOwner = current.restoredRuntimeHostIdByWorkspaceSessionKey?.[oldId]
    if (sourceOwner && sourceOwner !== hostId) continue
    const hasDestination =
      SESSION_MAPS.some((key) => Object.hasOwn(current[key] ?? {}, newId)) ||
      current.openFiles.some((file) => file.worktreeId === newId)
    const renamed = buildWorktreeRenameState(current, oldId, newId, hasDestination)
    patch = { ...patch, ...renamed }
    current = { ...current, ...renamed }
    rememberWorktreeRename(oldId, newId)
  }
  return patch
}
