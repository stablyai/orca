import { translate } from '@/i18n/i18n'
import type { ConfirmationDialogContextValue } from '@/components/confirmation-dialog-context'
import { useAppStore } from '@/store'
import type {
  WslMovedProject,
  WslMoveUseLocallyResult
} from '../../../shared/wsl-move/wsl-moved-project'

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
  // The reload brings the move's workspaces back as they were before it, dropping their unsaved
  // files; main knows which workspaces the move holds.
  const unsaved = useAppStore.getState().openFiles.filter((file) => file.isDirty)
  const result = await window.api.wslMove.useProjectHereAgain({
    kind: project.kind,
    id: project.id,
    unsavedWorkspaceIds: [...new Set(unsaved.map((file) => file.worktreeId))]
  })
  if (!result.released && result.reason === 'unsaved-files') {
    const inScope = new Set(result.unsavedWorkspaceIds)
    const files = unsaved
      .filter((file) => inScope.has(file.worktreeId))
      .map((file) => file.relativePath)
    await confirm({
      title: translate('sidebar.wslMoved.useHereUnsavedTitle', 'Save your files first'),
      description: translate(
        'sidebar.wslMoved.useHereUnsavedDescription',
        'Bringing {{name}} back reloads this window. Save or close these files first: {{files}}',
        { name: project.displayName, files: files.join(', ') }
      ),
      confirmLabel: translate('sidebar.wslMoved.useHereRefusedOk', 'OK'),
      acknowledgeOnly: true,
      initialFocus: 'confirm'
    })
    return
  }
  // On success main reloads the window, which hydrates the whole pre-move session from disk.
  if (!result.released) {
    // A dialog, not a toast: a toast sat behind the update notice and read as nothing.
    await confirm({
      title: translate('sidebar.wslMoved.useHereRefusedTitle', "Can't use {{name}} here yet", {
        name: project.displayName
      }),
      description: wslMoveUseHereRefusalMessage(result, project.distro),
      confirmLabel: translate('sidebar.wslMoved.useHereRefusedOk', 'OK'),
      acknowledgeOnly: true,
      initialFocus: 'confirm'
    })
  }
}

/** The newer move's projects by name, as the sidebar lists them; ids alone mean nothing to the user. */
function newerMoveNames(
  newerMove: { repoIds: string[]; folderWorkspaceIds: string[] } | undefined
): string[] {
  if (!newerMove) {
    return []
  }
  return useAppStore
    .getState()
    .wslMovedProjects.filter((moved) =>
      (moved.kind === 'repo' ? newerMove.repoIds : newerMove.folderWorkspaceIds).includes(moved.id)
    )
    .map((moved) => moved.displayName)
}

function wslMoveUseHereRefusalMessage(
  result: Extract<WslMoveUseLocallyResult, { released: false }>,
  distro: string
): string {
  const { reason } = result
  const names = reason === 'superseded' ? newerMoveNames(result.newerMove) : []
  if (names.length > 0) {
    return translate(
      'sidebar.wslMoved.useHereSupersededBy',
      '{{names}} moved to the {{distro}} host after this project. Use those on this computer again first, then this project.',
      { names: names.join(', '), distro }
    )
  }
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
  if (result.detail === 'host-removal-pending') {
    return translate(
      'sidebar.wslMoved.useHereHostRemovalPending',
      'The {{distro}} host is still being removed, so Orca leaves it alone. Finish removing it in Settings, then try again.',
      { distro }
    )
  }
  if (result.detail === 'host-automations') {
    return translate(
      'sidebar.wslMoved.useHereHostAutomations',
      "Orca couldn't turn off this project's automations on the {{distro}} host, so they could run twice. Connect the host in Settings, then try again.",
      { distro }
    )
  }
  if (reason === 'host-unreachable') {
    return translate(
      'sidebar.wslMoved.useHereHostUnreachable',
      "The {{distro}} host isn't answering, so Orca can't stop its copy of this project, and its agents may still be running there. Connect the host in Settings, or remove it, then try again.",
      { distro }
    )
  }
  if (reason === 'host-still-running') {
    return translate(
      'sidebar.wslMoved.useHereHostStillRunning',
      "The {{distro}} host's copy of this project is still running terminals, so its agents could run twice. Wait a moment, then try again.",
      { distro }
    )
  }
  return translate(
    'sidebar.wslMoved.useHereFailed',
    'Could not bring this project back to this computer.'
  )
}
