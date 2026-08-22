import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { getRuntimePathBasename } from '../../../../shared/cross-platform-path'
import type { NestedRepoScanResult } from '../../../../shared/project-group-types'
import { findMainFolderWorkspace } from '../../../../shared/repo-managed-project'
import { activateAndRevealFolderWorkspace } from '@/lib/worktree-activation'
import { translate } from '@/i18n/i18n'
import type { CapturedRuntimeOwner } from './add-repo-runtime-owner'

export async function completeRepoManagedOpen(args: {
  scan: NestedRepoScanResult
  generation: number
  currentGeneration: () => number
  connectionId?: string | null
  scanId?: string | null
  runtimeEnvironmentId?: CapturedRuntimeOwner
  closeModal: () => void
  setIsAdding: (value: boolean) => void
}): Promise<boolean> {
  args.setIsAdding(true)
  try {
    const state = useAppStore.getState()
    const result = await state.importNestedRepos({
      parentPath: args.scan.selectedPath,
      groupName: getRuntimePathBasename(args.scan.selectedPath),
      projectPaths: [],
      connectionId: args.connectionId ?? undefined,
      ...(args.scanId ? { scanId: args.scanId } : {}),
      mode: 'group',
      runtimeEnvironmentId: args.runtimeEnvironmentId ?? null
    })
    if (args.generation !== args.currentGeneration()) {
      return false
    }
    if (!result?.group) {
      toast.error(
        translate(
          'auto.components.sidebar.completeRepoManagedOpen.failed',
          'Failed to open the repo-managed project.'
        )
      )
      return false
    }
    const main = findMainFolderWorkspace(useAppStore.getState().folderWorkspaces, result.group)
    args.closeModal()
    if (main) {
      activateAndRevealFolderWorkspace(main.id, {
        runtimeEnvironmentId: args.runtimeEnvironmentId ?? null
      })
    }
    return true
  } catch (err) {
    if (args.generation === args.currentGeneration()) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
    return false
  } finally {
    if (args.generation === args.currentGeneration()) {
      args.setIsAdding(false)
    }
  }
}
