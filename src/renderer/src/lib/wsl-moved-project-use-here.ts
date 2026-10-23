import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { ConfirmationDialogContextValue } from '@/components/confirmation-dialog-context'
import type { WslMovedProject } from '../../../shared/wsl-move/wsl-moved-project'

/**
 * "Use on this computer again" for a project a WSL host owns: after a plain confirmation, the
 * project's pre-move rows return here. Nothing comes back from the host, and its copy stays.
 */
export async function bringWslMovedProjectBack(
  project: WslMovedProject,
  confirm: ConfirmationDialogContextValue
): Promise<void> {
  const confirmed = await confirm({
    title: translate('sidebar.wslMoved.useHereTitle', 'Use {{name}} on this computer again?', {
      name: project.displayName
    }),
    description: translate(
      'sidebar.wslMoved.useHereDescription',
      'Orca will open this project here as it was before the move. Your code is not affected: it never moved. Changes made on the {{distro}} host since the move, such as new tabs and chats, stay on the host and do not come back. Projects moved with it come back too. The project also stays on the {{distro}} host until you remove it there. This window reloads.',
      { distro: project.distro }
    ),
    confirmLabel: translate('sidebar.wslMoved.useHereConfirm', 'Use on this computer')
  })
  if (!confirmed) {
    return
  }
  const result = await window.api.wslMove.useProjectHereAgain({
    kind: project.kind,
    id: project.id
  })
  // On success main reloads the window, which hydrates the whole pre-move session from disk.
  if (!result.released) {
    toast.error(wslMoveUseHereRefusalMessage(result.reason, project.distro))
  }
}

function wslMoveUseHereRefusalMessage(reason: string, distro: string): string {
  if (reason === 'superseded') {
    return translate(
      'sidebar.wslMoved.useHereSuperseded',
      'A later move to the {{distro}} host includes this project. Bring that one back first.',
      { distro }
    )
  }
  if (reason === 'move-running') {
    return translate(
      'sidebar.wslMoved.useHereMoveRunning',
      'A move to the {{distro}} host is still running. Try again once it ends.',
      { distro }
    )
  }
  return translate(
    'sidebar.wslMoved.useHereFailed',
    'Could not bring this project back to this computer.'
  )
}
