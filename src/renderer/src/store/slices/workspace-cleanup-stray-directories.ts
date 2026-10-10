import { translate } from '@/i18n/i18n'
import type { AppState } from '../types'
import type { WorkspaceCleanupTrashStrayDirectoryResult } from '../../../../shared/workspace-cleanup-stray-directories'

type SetState = (
  partial: Partial<AppState> | ((state: AppState) => Partial<AppState>),
  replace?: false
) => void

/** Main re-checks the folder before moving it; the renderer only drops the row once that succeeds. */
export async function trashWorkspaceCleanupStrayDirectory(
  set: SetState,
  path: string
): Promise<WorkspaceCleanupTrashStrayDirectoryResult> {
  const trash = window.api.workspaceCleanup.trashStrayDirectory
  if (!trash) {
    return {
      ok: false,
      message: translate(
        'components.workspace.cleanup.strayFolders.trashUnavailable',
        'This host cannot move folders to the Trash.'
      )
    }
  }
  const result = await trash({ path })
  if (result.ok) {
    set((state) => {
      const scan = state.workspaceCleanupScan
      if (!scan?.strayDirectoryScan) {
        return {}
      }
      return {
        workspaceCleanupScan: {
          ...scan,
          strayDirectoryScan: {
            ...scan.strayDirectoryScan,
            directories: scan.strayDirectoryScan.directories.filter(
              (directory) => directory.path !== path
            )
          }
        }
      }
    })
  }
  return result
}
