import { useAppStore } from '@/store/index'
import { activateAndRevealWorkspaceWithOutcome } from '@/lib/workspace/activation/worktree-activation'
import { getRelativePathInsideRoot } from '@/lib/path'
import { isWorkspaceSelected } from '@/lib/workspace/ownership/active-workspace-host'
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
  folderPath: string,
  onFailure: (failure: FileOpenFailure) => void
): void {
  // Why the host too: workspace IDs repeat across hosts, so a same-ID local twin is not the owner.
  if (!isWorkspaceSelected(useAppStore.getState(), { worktreeId, executionHostId })) {
    const outcome = activateAndRevealWorkspaceWithOutcome(worktreeId, { executionHostId })
    if ('refused' in outcome) {
      // Why: a blocked folder workspace already said why; a second toast would repeat it.
      if (!outcome.refused.failureNotified) {
        onFailure({ verdict: 'unavailable' })
      }
      return
    }
  }
  useAppStore.getState().revealInExplorer(worktreeId, folderPath)
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
    } else {
      revealFolderInWorktree(
        hostWorkspaceFile.worktreeId,
        hostWorkspaceFile.executionHostId,
        folderPath,
        onFailure
      )
    }
    return
  }
  // Why: this computer's OS can't open an SSH or paired folder; the workspace explorer reads through its host.
  if (getRelativePathInsideRoot(folderPath, args.worktreePath) !== null) {
    revealFolderInWorktree(args.worktreeId, args.sourceHostId, folderPath, onFailure)
    return
  }
  onFailure({ verdict: 'unavailable' })
}
