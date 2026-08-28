import {
  getTerminalFileContext,
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
  if (isTerminalLinkDirectActivation(event)) {
    event?.preventDefault?.()
    openDetectedFilePath(filePath, line, column, {
      ...deps,
      openWithSystemDefault: Boolean(event?.shiftKey)
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

  return requestTerminalLinkAction(event, actionContext, {
    destination: actionDestination ?? mappedPath,
    kind: worktreeRoot ? 'workspace' : 'file',
    primary: {
      label: worktreeRoot
        ? translate(
            'auto.components.terminal.pane.TerminalLinkActionPopover.switchWorkspace',
            'Switch workspace'
          )
        : translate(
            'auto.components.terminal.pane.TerminalLinkActionPopover.openFile',
            'Open file'
          ),
      run: () => openDetectedFilePath(filePath, line, column, deps)
    },
    ...(canOpenWithSystemDefault
      ? {
          alternate: {
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
        }
      : {})
  })
}
