import {
  getTerminalFileContext,
  isTerminalFileLinkModifierInverted,
  mapTerminalFilePath,
  openDetectedFilePath,
  shouldOpenTerminalFileWithSystemDefault,
  terminalLinkWslDistro
} from './terminal-file-open-routing'
import { isTerminalLinkDirectActivation } from './terminal-link-activation'
import {
  requestTerminalLinkAction,
  type TerminalLinkActionContext
} from './terminal-link-action-request'
import { resolveKnownWorktreeRootPathLink } from './terminal-worktree-path-link'
import { translate } from '@/i18n/i18n'

export type TerminalFileLinkActionDeps = {
  worktreeId: string
  worktreePath: string
  runtimeEnvironmentId?: string | null
  wslDistro?: string | null
}

export function handleTerminalFileLink(
  filePath: string,
  line: number | null,
  column: number | null,
  event: MouseEvent | undefined,
  deps: TerminalFileLinkActionDeps,
  actionContext?: TerminalLinkActionContext | null,
  actionDestination?: string
): boolean {
  const modifierInverts = isTerminalFileLinkModifierInverted()
  if (isTerminalLinkDirectActivation(event)) {
    event?.preventDefault?.()
    openDetectedFilePath(filePath, line, column, {
      ...deps,
      // Why: Shift normally picks the OS default app; inverting swaps the two chords.
      openWithSystemDefault: Boolean(event?.shiftKey) !== modifierInverts
    })
    return true
  }

  const mappedPath = mapTerminalFilePath(
    filePath,
    deps.worktreePath,
    terminalLinkWslDistro(deps.wslDistro, deps.runtimeEnvironmentId)
  )
  const fileContext = getTerminalFileContext(
    deps.worktreeId,
    deps.worktreePath,
    deps.runtimeEnvironmentId
  )
  const worktreeRoot = resolveKnownWorktreeRootPathLink(mappedPath)
  const canOpenWithSystemDefault = shouldOpenTerminalFileWithSystemDefault(fileContext, mappedPath)
  const isMac = navigator.userAgent.includes('Mac')

  const orcaAction = {
    label: worktreeRoot
      ? translate(
          'auto.components.terminal.pane.TerminalLinkActionPopover.switchWorkspace',
          'Switch workspace'
        )
      : translate('auto.components.terminal.pane.TerminalLinkActionPopover.openFile', 'Open file'),
    run: () => openDetectedFilePath(filePath, line, column, deps)
  }
  const systemDefaultAction = {
    label: worktreeRoot
      ? isMac
        ? translate(
            'auto.components.terminal.pane.TerminalLinkActionPopover.openInFinder',
            'Open in Finder'
          )
        : translate(
            'auto.components.terminal.pane.TerminalLinkActionPopover.openFolder',
            'Open folder'
          )
      : translate(
          'auto.components.terminal.pane.TerminalLinkActionPopover.openWithDefaultApp',
          'Open with default app'
        ),
    run: () =>
      openDetectedFilePath(filePath, line, column, {
        ...deps,
        openWithSystemDefault: true
      })
  }
  // Why: the popover's primary must match what the bare modifier click does.
  const primaryIsSystemDefault = modifierInverts && canOpenWithSystemDefault

  return requestTerminalLinkAction(event, actionContext, {
    destination: actionDestination ?? mappedPath,
    kind: worktreeRoot ? 'workspace' : 'file',
    primary: primaryIsSystemDefault ? systemDefaultAction : orcaAction,
    ...(canOpenWithSystemDefault
      ? { alternate: primaryIsSystemDefault ? orcaAction : systemDefaultAction }
      : {})
  })
}
