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
import { downloadAndOpenRemoteTerminalFile } from './terminal-remote-file-download-open'
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

  // Why: the OS can only launch a local file, so remote links keep the same row by
  // downloading first — local and remote workspaces offer the same actions.
  const systemDefaultRow = worktreeRoot
    ? canOpenWithSystemDefault
      ? {
          label: isMac
            ? translate(
                'auto.components.terminal.pane.TerminalLinkActionPopover.openInFinder',
                'Open in Finder'
              )
            : translate(
                'auto.components.terminal.pane.TerminalLinkActionPopover.openFolder',
                'Open folder'
              ),
          run: () =>
            openDetectedFilePath(filePath, line, column, { ...deps, openWithSystemDefault: true })
        }
      : null
    : canOpenWithSystemDefault
      ? {
          label: translate(
            'auto.components.terminal.pane.TerminalLinkActionPopover.openWithDefaultApp',
            'Open with default app'
          ),
          run: () =>
            openDetectedFilePath(filePath, line, column, { ...deps, openWithSystemDefault: true })
        }
      : // Why the path shape and not a stat: the popover is built synchronously on hover, and a
        // remote stat per link would put a round-trip in front of every terminal path. A directory
        // that does not announce itself with a separator still fails visibly, in the download toast.
        /[/\\]$/.test(mappedPath)
        ? null
        : {
            label: translate(
              'auto.components.terminal.pane.TerminalLinkActionPopover.downloadOpenWithDefaultApp',
              'Download & open with default app'
            ),
            run: () => downloadAndOpenRemoteTerminalFile(fileContext, mappedPath)
          }
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
    ...(systemDefaultRow ? { alternate: systemDefaultRow } : {})
  })
}
