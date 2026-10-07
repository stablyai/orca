import { toast } from 'sonner'
import { useAppStore } from '@/store'
import type { NestedRepoScanResult } from '../../../../shared/project-group-types'
import type { Repo } from '../../../../shared/repo-types'
import type { CapturedRuntimeOwner } from './add-repo-runtime-owner'
import { trackNestedFolderOpen } from './track-nested-folder-open'
import { upsertAddedRepoWithProjectHostSetup } from './add-repo-store-upsert'
import { worktreeRefreshOptions } from './add-repo-runtime-owner'
import type { WorktreeFetchOptions } from '@/store/slices/worktree-helpers'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { AddRepoExistingWorkspaceSource } from '../../../../shared/telemetry-events'

export async function completeNestedFolderOpen(args: {
  scan: NestedRepoScanResult
  generation: number
  currentGeneration: () => number
  attemptId: string | null
  runtimeKind: Parameters<typeof trackNestedFolderOpen>[0]['runtimeKind']
  connectionId: string | null
  selectedCount: number
  getRuntimeKind: Parameters<typeof trackNestedFolderOpen>[0]['getRuntimeKind']
  owner: CapturedRuntimeOwner
  /** User-entered project name; falls back to the host's basename naming when absent. */
  displayName?: string
  closeModal: () => void
  setIsAdding: (value: boolean) => void
  fetchWorktrees?: (repoId: string, options?: WorktreeFetchOptions) => Promise<unknown>
  onGitRepoReady?: (
    repoId: string,
    source: AddRepoExistingWorkspaceSource,
    executionHostId?: ExecutionHostId
  ) => Promise<void>
}): Promise<void> {
  if (args.scan.selectedPathKind !== 'git_repo') {
    trackNestedFolderOpen(args)
  }
  args.setIsAdding(true)
  try {
    const state = useAppStore.getState()
    if (args.scan.selectedPathKind === 'git_repo') {
      let repo: Repo | null
      if (args.connectionId) {
        const result = await window.api.repos.addRemote({
          connectionId: args.connectionId,
          remotePath: args.scan.selectedPath
        })
        if ('error' in result) {
          throw new Error(result.error)
        }
        const added = upsertAddedRepoWithProjectHostSetup(result.repo, {
          sshConnectionId: args.connectionId
        })
        repo = added.repo
        if (added.alreadyPresent) {
          state.clearOrcaHookTrustForRepo(repo.id)
        }
      } else {
        repo = await state.addRepoPath(args.scan.selectedPath, 'git', {
          runtimeEnvironmentId: args.owner ?? null
        })
      }
      if (!repo || args.generation !== args.currentGeneration()) {
        return
      }
      const ownerOptions = worktreeRefreshOptions(args.owner, args.connectionId)
      await args.fetchWorktrees?.(repo.id, ownerOptions)
      if (args.generation !== args.currentGeneration()) {
        return
      }
      const source = args.connectionId
        ? 'ssh_remote_path'
        : args.owner
          ? 'runtime_server_path'
          : 'local_folder_picker'
      await args.onGitRepoReady?.(repo.id, source, ownerOptions.executionHostId)
      return
    }
    if (args.connectionId) {
      args.closeModal()
      state.openModal('confirm-non-git-folder', {
        folderPath: args.scan.selectedPath,
        connectionId: args.connectionId,
        runtimeEnvironmentId: args.owner,
        ...(args.displayName ? { displayName: args.displayName } : {})
      })
      return
    }
    const repo = await state.addNonGitFolder(args.scan.selectedPath, {
      runtimeEnvironmentId: args.owner ?? null,
      ...(args.displayName ? { displayName: args.displayName } : {})
    })
    if (args.generation !== args.currentGeneration()) {
      return
    }
    if (repo) {
      args.closeModal()
    }
  } catch (err) {
    if (args.generation === args.currentGeneration()) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  } finally {
    if (args.generation === args.currentGeneration()) {
      args.setIsAdding(false)
    }
  }
}
