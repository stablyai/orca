import type { AppState } from '@/store/types'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { resolveHookCommandSourcePolicy } from '../../../shared/hook-command-source-policy'
import { checkRuntimeHooks } from '@/runtime/runtime-hooks-client'
import {
  confirmInspectedHookScript,
  findHookRepo,
  hookRepoOwnerHostId,
  type HookWorkspaceTarget
} from './ensure-hooks-confirmed'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import { isFolderRepo } from '../../../shared/repo-kind'
import { findRepoForHost } from '@/store/slices/repo-host-identity'
import { findKnownWorktreeById } from '@/store/slices/worktrees/listing/detected-worktree-meta'

export async function confirmWorkspaceRemovalHooks(
  get: () => AppState,
  worktreeId: string,
  hostId: ExecutionHostId | undefined,
  runtimeOwner: string | null | undefined,
  forgetLocalOnly: boolean
): Promise<{ skipArchive: boolean; removeHookHash?: string }> {
  const repoId = getRepoIdFromWorktreeId(worktreeId)
  const owner = findRepoForHost(get().repos, repoId, { hostId, settings: get().settings })
  if (
    forgetLocalOnly ||
    parseWorkspaceKey(worktreeId)?.type === 'folder' ||
    (owner !== null && isFolderRepo(owner))
  ) {
    return { skipArchive: true }
  }
  const selected = hostId ? findKnownWorktreeById(get(), worktreeId, hostId) : undefined
  const workspace = selected
    ? { name: selected.displayName || selected.path, path: selected.path }
    : undefined
  return confirmWorktreeRemovalHooks(get, repoId, hostId, runtimeOwner, workspace)
}

/** Removal consent covers the exact effective host script, including user-owned local commands. */
export async function confirmWorktreeRemovalHooks(
  get: () => AppState,
  repoId: string,
  hostId?: ExecutionHostId,
  runtimeOwnerEnvironmentId?: string | null,
  workspace?: HookWorkspaceTarget
): Promise<{ skipArchive: boolean; removeHookHash?: string }> {
  const state = get()
  const result = await checkRuntimeHooks(
    hookRepoOwnerHostId(state, repoId, hostId, runtimeOwnerEnvironmentId),
    repoId
  )
  if (result.status === 'error') {
    throw new Error(
      'Could not inspect the removal action on the workspace host. Refresh the connection and retry.'
    )
  }
  if (result.supportsRemoveHook !== true || typeof result.effectiveRemoveScript !== 'string') {
    throw new Error(
      'Update Orca on the workspace host before removing this checkout; it cannot confirm required cleanup support.'
    )
  }
  const script = result.effectiveRemoveScript.trim()
  if (script) {
    const removeHookHash = result.effectiveRemoveHookHash
    if (typeof removeHookHash !== 'string' || !/^[a-f0-9]{64}$/.test(removeHookHash)) {
      throw new Error('The workspace host did not provide a verifiable removal script digest.')
    }
    const decision = await confirmInspectedHookScript(
      get,
      repoId,
      'remove',
      script,
      hostId,
      workspace
    )
    if (decision !== 'run') {
      throw new Error('Workspace removal cancelled; the required removal script was not approved.')
    }
    return { skipArchive: true, removeHookHash }
  }
  const repo = findHookRepo(get(), repoId, hostId)
  const sourcePolicy = resolveHookCommandSourcePolicy(repo?.hookSettings?.commandSourcePolicy, {
    hasLocalScript: Boolean(repo?.hookSettings?.scripts.archive?.trim())
  })
  const archive = sourcePolicy === 'local-only' ? '' : (result.hooks?.scripts.archive?.trim() ?? '')
  return {
    skipArchive:
      (await confirmInspectedHookScript(get, repoId, 'archive', archive, hostId)) === 'skip'
  }
}
