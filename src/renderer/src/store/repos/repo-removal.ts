import { runEnclosingWorktreeRemoval } from '@/store/active-worktree-deselection-intent'
import { isRemoteRuntimePtyId } from '../../../../shared/remote-runtime-pty-id'
import type { StateCreator } from 'zustand'
import { toast } from 'sonner'
import type { AppState } from '../types'
import { repoMatchesHostIdentity } from '../slices/repo-host-identity'
import { callRuntimeRpc } from '../../runtime/runtime-rpc-client'
import { hasRuntimeRpcErrorCode } from '../../../../shared/runtime-rpc-error-code'
import { ipcOrRuntimeTargetForHostId } from '../../runtime/runtime-client-target'
import { translate } from '@/i18n/i18n'
import { readIpcErrorMessage } from '@/lib/ipc-error'
import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import { destroyRecipeVmBeforeProjectRemoval } from './recipe-vm-project-removal'
import { stopRuntimeProjectTerminalsBeforeRemoval } from './runtime-project-terminal-stop'
import type { RepoSlice } from './repo-state'
import { ERROR_TOAST_DURATION } from './repo-state'
import {
  closeRemovedHostTwinState,
  collectRemovedHostTwins
} from './repo-removal-host-twin-teardown'
import { removedProjectStatePatch, worktreeBelongsToHost } from './repo-removal-state-patch'
import {
  captureWorkspaceChatDraftKeys,
  deleteWorkspaceChatDrafts
} from '../slices/worktrees/teardown/removed-worktree-chat-drafts'
import {
  flushPurgedWorkspaceEdits,
  noticeRemovedUnsavedFiles
} from '../slices/worktrees/teardown/removed-workspace-unsaved-files'
import { worktreePurgeClosedFileIds } from '../slices/worktrees/teardown/worktree-purge-closed-files'
import { selectRepos } from '../project-catalog-selectors'
import { ORCA_SIDEBAR_INPUTS_IS_MAIN } from '../../../../shared/sidebar-inputs-switch'
import { mainCatalogShowsWrite } from '../main-project-catalog-writes'

type HostScopedWorktreeRef = { id: string; hostId?: string }

type RepoWorktreeCatalog = {
  worktreesByRepo: Readonly<Record<string, readonly HostScopedWorktreeRef[] | undefined>>
  detectedWorktreesByRepo: Readonly<
    Record<string, { worktrees: readonly HostScopedWorktreeRef[] } | undefined>
  >
}

export function getKnownRepoWorktreeIds(
  state: RepoWorktreeCatalog,
  projectId: string,
  hostId?: string
): string[] {
  const ids = new Set<string>()
  for (const worktree of state.worktreesByRepo[projectId] ?? []) {
    if (!hostId || worktreeBelongsToHost(worktree, hostId)) {
      ids.add(worktree.id)
    }
  }
  for (const worktree of state.detectedWorktreesByRepo[projectId]?.worktrees ?? []) {
    if (!hostId || worktreeBelongsToHost(worktree, hostId)) {
      ids.add(worktree.id)
    }
  }
  return [...ids]
}

/** Terminal tabs that removing this project's host row will close. */
export function countOpenRepoTerminalTabs(
  state: RepoWorktreeCatalog & {
    tabsByWorktree: Readonly<Record<string, readonly { id: string }[] | undefined>>
    ptyIdsByTabId: Readonly<Record<string, readonly string[] | undefined>>
  },
  projectId: string,
  hostId: string
): number {
  let count = 0
  for (const worktreeId of getKnownRepoWorktreeIds(state, projectId, hostId)) {
    for (const tab of state.tabsByWorktree[worktreeId] ?? []) {
      if ((state.ptyIdsByTabId[tab.id]?.length ?? 0) > 0) {
        count += 1
      }
    }
  }
  return count
}

/** A listing that fails reads as registered, so the host is still asked as before. */
async function isRuntimeEnvironmentRegistered(environmentId: string): Promise<boolean> {
  try {
    const environments = await window.api.runtimeEnvironments.list()
    return environments.some((environment) => environment.id === environmentId)
  } catch {
    return true
  }
}

export function createRepoRemovalActions(
  set: Parameters<StateCreator<AppState>>[0],
  get: Parameters<StateCreator<AppState>>[1]
): Pick<RepoSlice, 'removeProject'> {
  const actions: Pick<RepoSlice, 'removeProject'> = {
    removeProject: async (projectId, options) => {
      try {
        // Why: exact host match only; the unique-candidate/focused fallbacks could pick another host's row (#13071).
        const ownerRepo = selectRepos(get()).find((repo) =>
          repoMatchesHostIdentity(repo, projectId, options.hostId)
        )
        if (!ownerRepo) {
          return
        }
        const ownerHostId = getRepoExecutionHostId(ownerRepo)
        // Why only awaited for a VM: concurrent removals of one row must reach the host together.
        const vmDestroy = destroyRecipeVmBeforeProjectRemoval(
          get(),
          ownerRepo,
          ownerHostId,
          getKnownRepoWorktreeIds(get(), projectId, ownerHostId)
        )
        const vmServerDestroyed = vmDestroy !== false && (await vmDestroy)
        // Why: derive the target from the owner row's host so an SSH host removal never routes repo.rm to the focused runtime.
        const target = ipcOrRuntimeTargetForHostId(ownerHostId)
        if (!target) {
          throw new Error('The project host is unresolved. Refresh and retry.')
        }
        const knownWorktreeIds = getKnownRepoWorktreeIds(get(), projectId, ownerHostId)
        // Why before the host call: its announcement can start a listing refresh that drops these tabs.
        const preCallTwins = collectRemovedHostTwins(get(), knownWorktreeIds, ownerHostId)
        const removedTwinEntityIds = new Set(
          preCallTwins.byHost.flatMap(({ removed }) => [
            ...removed.terminalTabIds,
            ...removed.conversationIds
          ])
        )
        const chatDraftKeys = captureWorkspaceChatDraftKeys(
          get(),
          knownWorktreeIds.map((workspaceId) => ({
            workspaceId,
            executionHostId: ownerHostId,
            ...(preCallTwins.twinHostIds.has(workspaceId)
              ? { onlyEntityIds: removedTwinEntityIds }
              : {})
          }))
        )
        // Why: a stopped or forgotten server leaves rows nothing can reach; only this desktop's copy goes.
        const hostGone =
          target.kind === 'environment' &&
          !vmServerDestroyed &&
          !(await isRuntimeEnvironmentRegistered(target.environmentId))
        if (target.kind === 'environment' && !vmServerDestroyed && !hostGone) {
          await stopRuntimeProjectTerminalsBeforeRemoval(
            target.environmentId,
            projectId,
            // Why re-read: the registration await can let a listing refresh add worktrees.
            getKnownRepoWorktreeIds(get(), projectId, ownerHostId)
          )
        }
        try {
          // Why: destroying the VM took its server, and the catalog holding this row, with it.
          if (!vmServerDestroyed && !hostGone) {
            // Why: always host-scoped; this catalog may be stale and miss a same-id row on another host (#13071).
            await (target.kind === 'local'
              ? window.api.repos.removeForHost({ repoId: projectId, hostId: ownerHostId })
              : callRuntimeRpc(target, 'repo.rm', { repo: projectId }, { timeoutMs: 15_000 }))
          }
        } catch (err) {
          // Why: the owner already dropped this project, so purge the local ghost row instead of aborting (#11994).
          if (!hasRuntimeRpcErrorCode(err, 'repo_not_found')) {
            throw err
          }
        }
        if (target.kind === 'environment') {
          // Why: the host confirmed the removal (or is gone), and this desktop's own persisted rows
          // for that host are swept only by an explicit removal, never by the startup sweep (#17776).
          // A paired web client keeps no such rows, and its bridge throws synchronously.
          try {
            await window.api.repos.removeForHost({ repoId: projectId, hostId: ownerHostId })
          } catch (error) {
            console.warn('[repos] failed to drop paired-host project residue', error)
          }
        }

        get().clearOrcaHookTrustForRepo(projectId)
        const repoPath = selectRepos(get()).find((repo) =>
          repoMatchesHostIdentity(repo, projectId, ownerHostId)
        )?.path
        get().evictGitHubRepoCaches(projectId, repoPath, ownerHostId)
        const { clearRepoSlugCacheEntry } = await import('../../lib/repo-slug-index')
        clearRepoSlugCacheEntry(projectId)

        const worktreeIds = [
          ...new Set([
            ...knownWorktreeIds,
            ...getKnownRepoWorktreeIds(get(), projectId, ownerHostId)
          ])
        ]
        // Why rechecked: a concurrent removal of the other copy leaves no survivor to share with.
        const twins = collectRemovedHostTwins(get(), worktreeIds, ownerHostId)
        const exclusiveWorktreeIds = worktreeIds.filter((id) => !twins.twinHostIds.has(id))
        const localAgentContextProjectIds =
          ownerHostId === LOCAL_EXECUTION_HOST_ID
            ? [
                projectId,
                ...(get().worktreesByRepo[projectId] ?? [])
                  .filter((worktree) => worktreeBelongsToHost(worktree, ownerHostId))
                  .flatMap((worktree) => (worktree.projectId ? [worktree.projectId] : []))
              ]
            : []
        // Backstop for the host's sweep, which a spent budget or reloading graph can cut short.
        for (const wId of exclusiveWorktreeIds) {
          const tabs = get().tabsByWorktree[wId] ?? []
          for (const tab of tabs) {
            for (const ptyId of get().ptyIdsByTabId[tab.id] ?? []) {
              if (!isRemoteRuntimePtyId(ptyId)) {
                window.api.pty.kill(ptyId)
              }
            }
          }
        }

        // Why: use the canonical per-worktree purge to evict all worktree-scoped maps (hand-deletion leaked most); runs before the set() below so it still sees tabsByWorktree.
        const purgeTargets = worktreeIds.map((id) => ({ id, hostId: ownerHostId }))
        flushPurgedWorkspaceEdits(get(), purgeTargets)
        // Why before the twin close: it closes tabs one by one; the purge below shares this batch.
        noticeRemovedUnsavedFiles(
          get(),
          worktreePurgeClosedFileIds(get(), purgeTargets),
          options.confirmedDiscards
        )
        closeRemovedHostTwinState(get, set, twins, preCallTwins)
        get().purgeWorktreeTerminalState(exclusiveWorktreeIds)
        deleteWorkspaceChatDrafts(chatDraftKeys)
        get().clearLocalDetectedAgentContextsForProjects(localAgentContextProjectIds)
        // Switch point: main's catalog drops the row; the window's own state follows once it has.
        if (ORCA_SIDEBAR_INPUTS_IS_MAIN) {
          await mainCatalogShowsWrite(
            target,
            (catalog) =>
              !catalog.repos.some((repo) => repoMatchesHostIdentity(repo, projectId, ownerHostId))
          )
        }

        set((s) => removedProjectStatePatch(s, projectId, ownerHostId, worktreeIds, twins))
      } catch (err) {
        console.error('Failed to remove repo:', err)
        // Why: bulk and background callers aggregate their own failures, so only opted-in single-project entry points toast (#11994).
        if (options.errorFeedback === 'toast') {
          toast.error(
            translate('auto.store.slices.repos.removeProjectFailed', 'Failed to remove project'),
            {
              description: readIpcErrorMessage(err) ?? String(err),
              duration: ERROR_TOAST_DURATION
            }
          )
        }
      }
    }
  }
  return {
    removeProject: (projectId, options) =>
      runEnclosingWorktreeRemoval(
        options.automaticCleanup ? null : { hostId: options.hostId, repoId: projectId },
        () => actions.removeProject(projectId, options)
      )
  }
}
