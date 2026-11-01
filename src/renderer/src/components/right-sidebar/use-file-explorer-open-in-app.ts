import { useCallback } from 'react'
import { useAppStore } from '@/store'
import { getLocalPathOpenOwnerHostId, type LocalPathOpenOwner } from '@/lib/local-path-open-guard'
import { getFileExplorerOpenInApplication } from '@/lib/open-in-application-selection'
import { openWorktreePath } from '@/components/sidebar/WorktreeOpenInMenu'
import {
  getOpenInApplicationAvailability,
  useOpenInPathRoute
} from '@/components/sidebar/use-open-in-path-route'

/**
 * Opens a clicked file in the app chosen in Settings and reports whether it did; false (no app
 * chosen, or the app can't reach this workspace) leaves the file to the Orca editor.
 */
export function useFileExplorerOpenInApp(
  activeWorktreeId: string | null,
  pathOwner: LocalPathOpenOwner
): (path: string) => boolean {
  const application = useAppStore((s) => getFileExplorerOpenInApplication(s.settings))
  const { route, workspace, runtimeSshHost } = useOpenInPathRoute(
    activeWorktreeId,
    getLocalPathOpenOwnerHostId(pathOwner)
  )

  return useCallback(
    (path) => {
      if (!application || !workspace) {
        return false
      }
      if (getOpenInApplicationAvailability(application, route, runtimeSshHost).disabled) {
        return false
      }
      void openWorktreePath({
        target: 'external-editor',
        worktreePath: path,
        ...route,
        workspace,
        command: application.command,
        subject: 'path'
      })
      return true
    },
    [application, route, runtimeSshHost, workspace]
  )
}
