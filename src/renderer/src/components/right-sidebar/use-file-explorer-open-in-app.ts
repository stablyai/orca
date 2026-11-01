import { useCallback } from 'react'
import { useAppStore } from '@/store'
import { getLocalPathOpenOwnerHostId, type LocalPathOpenOwner } from '@/lib/local-path-open-guard'
import { getFileExplorerOpenInApplication } from '@/lib/open-in-application-selection'
import { openWorktreePath } from '@/components/sidebar/WorktreeOpenInMenu'
import {
  getOpenInApplicationAvailability,
  useOpenInPathRoute
} from '@/components/sidebar/use-open-in-path-route'

export type ChosenAppClick = {
  /** The second click of a double-click, which the first one already launched for. */
  repeated: boolean
  /** Runs when the launch fails, so the click still opens the file. */
  openInOrca: () => void
}

/**
 * Opens a clicked file in the app chosen in Settings and reports whether the app took it; false
 * (no app chosen, or the app can't reach this workspace) leaves the file to the Orca editor.
 * A repeated click of a double-click is taken without relaunching, since the first one launched.
 * If the launch fails, `openInOrca` opens the file in the Orca editor so the click is never lost.
 */
export function useFileExplorerOpenInApp(
  activeWorktreeId: string | null,
  pathOwner: LocalPathOpenOwner
): (path: string, click: ChosenAppClick) => boolean {
  const application = useAppStore((s) => getFileExplorerOpenInApplication(s.settings))
  const { route, workspace, runtimeSshHost } = useOpenInPathRoute(
    activeWorktreeId,
    getLocalPathOpenOwnerHostId(pathOwner)
  )

  return useCallback(
    (path, { repeated, openInOrca }) => {
      if (!application || !workspace) {
        return false
      }
      if (getOpenInApplicationAvailability(application, route, runtimeSshHost).disabled) {
        return false
      }
      if (repeated) {
        return true
      }
      void openWorktreePath({
        target: 'external-editor',
        worktreePath: path,
        ...route,
        workspace,
        command: application.command,
        subject: 'path'
      }).then((opened) => {
        if (!opened) {
          openInOrca()
        }
      })
      return true
    },
    [application, route, runtimeSshHost, workspace]
  )
}
