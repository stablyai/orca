import { useAppStore } from '@/store/index'
import { activateAndRevealWorkspace } from '@/lib/workspace/activation/worktree-activation'
import { getRelativePathInsideRoot } from '@/lib/path'
import {
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../../../../shared/execution-host'
import {
  isHostWorkspaceRoot,
  revealHostWorkspaceRoot,
  type HostWorkspaceFile
} from '../../host-files/terminal-host-workspace-file'
import type { FileOpenFailure } from './terminal-file-open-failure'

/** The explorer only reveals inside the worktree it shows, so switch to the folder's owner first. */
function revealFolderInWorktree(
  worktreeId: string,
  executionHostId: ExecutionHostId,
  folderPath: string
): boolean {
  if (useAppStore.getState().activeWorktreeId !== worktreeId) {
    if (activateAndRevealWorkspace(worktreeId, { executionHostId }) === false) {
      return false
    }
  }
  useAppStore.getState().revealInExplorer(worktreeId, folderPath)
  return true
}

type FolderOpenArgs = {
  folderPath: string
  worktreeId: string
  worktreePath: string
  hostWorkspaceFile: HostWorkspaceFile | null
  sourceHostId: ExecutionHostId
  openWithSystemDefault: boolean
  onFailure: (failure: FileOpenFailure) => void
}

/** A folder opens with the OS where it is local; otherwise it is revealed in the worktree that owns it. */
export async function openDetectedFolder(args: FolderOpenArgs): Promise<void> {
  const { folderPath, hostWorkspaceFile, onFailure } = args
  if (args.openWithSystemDefault) {
    let opened = false
    try {
      opened = await window.api.shell.openFilePath(folderPath, LOCAL_EXECUTION_HOST_ID)
    } catch {
      opened = false
    }
    if (!opened) {
      onFailure({ verdict: 'unavailable' })
    }
    return
  }
  if (hostWorkspaceFile) {
    if (isHostWorkspaceRoot(hostWorkspaceFile)) {
      revealHostWorkspaceRoot(hostWorkspaceFile)
    } else if (
      !revealFolderInWorktree(
        hostWorkspaceFile.worktreeId,
        hostWorkspaceFile.executionHostId,
        folderPath
      )
    ) {
      onFailure({ verdict: 'unavailable' })
    }
    return
  }
  // Why: this computer's OS can't open an SSH or paired folder; the workspace explorer reads through its host.
  if (
    getRelativePathInsideRoot(folderPath, args.worktreePath) !== null &&
    revealFolderInWorktree(args.worktreeId, args.sourceHostId, folderPath)
  ) {
    return
  }
  onFailure({ verdict: 'unavailable' })
}
