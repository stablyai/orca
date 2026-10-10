import type { LinkActionRequest } from '@/components/link-actions/link-action-request'
import type { HttpLinkSourceOwner } from '@/lib/http-link-routing'
import {
  getTerminalFileContext,
  mapTerminalFilePath,
  openDetectedFilePath,
  shouldOpenTerminalFileWithSystemDefault,
  terminalLinkWslDistro,
  type FileOpenFailure
} from './terminal-file-open-routing'
import { isTerminalLinkDirectActivation } from './terminal-link-activation'
import {
  requestTerminalLinkAction,
  type TerminalLinkActionContext
} from './terminal-link-action-request'
import { resolveKnownWorktreeRootPathLink } from './terminal-worktree-path-link'
import { translate } from '@/i18n/i18n'
import { getRevealInFileManagerLabel, revealInFileManager } from '@/lib/reveal-in-file-manager'
import { useAppStore } from '@/store'
import { getLocalPathOpenOwnerForRoute, isLocalPathOpenBlocked } from '@/lib/local-path-open-guard'

export type TerminalFileLinkActionDeps = {
  worktreeId: string
  worktreePath: string
  runtimeEnvironmentId?: string | null
  wslDistro?: string | null
  onOpenFailure?: (failure: FileOpenFailure) => void
}

export type FileLinkActions = Pick<
  LinkActionRequest,
  'destination' | 'kind' | 'primary' | 'alternate' | 'secondaryActions'
>

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
  const actions = buildFileLinkActions(filePath, line, column, deps, actionContext?.sourceOwner)
  return requestTerminalLinkAction(event, actionContext, {
    ...actions,
    destination: actionDestination ?? actions.destination
  })
}

/** The file-link popover's rows (open in Orca, default app, reveal), shared by terminal and chat. */
export function buildFileLinkActions(
  filePath: string,
  line: number | null,
  column: number | null,
  deps: TerminalFileLinkActionDeps,
  sourceOwner: HttpLinkSourceOwner | undefined
): FileLinkActions {
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
  const worktreeRoot = resolveKnownWorktreeRootPathLink(
    mappedPath,
    useAppStore.getState(),
    fileContext
  )
  const canOpenWithSystemDefault = shouldOpenTerminalFileWithSystemDefault(fileContext)
  const isMac = navigator.userAgent.includes('Mac')

  // Why: the OS can only launch a local file, so remote links keep the same row by
  // downloading first — local and remote workspaces offer the same actions.
  const systemDefaultRow = !fileContext.sourceHostResolved
    ? null
    : worktreeRoot
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
              // Why the open flow, not a direct download: a path the host disowns may be on this computer.
              run: () =>
                openDetectedFilePath(filePath, line, column, {
                  ...deps,
                  openWithSystemDefault: true
                })
            }
  // Why omit, not disable: the popover has no disabled rows. The OS file manager can only show a
  // file on this machine.
  const revealOwner = getLocalPathOpenOwnerForRoute({
    runtimeEnvironmentId: deps.runtimeEnvironmentId
  })
  const canReveal =
    !worktreeRoot &&
    canOpenWithSystemDefault &&
    sourceOwner?.kind === 'local' &&
    !isLocalPathOpenBlocked(revealOwner)
  // Why the shared reveal: it selects a folder (or a macOS .app bundle) in its parent, never opens it.
  const revealRow = canReveal
    ? {
        external: true,
        label: getRevealInFileManagerLabel(),
        run: () => revealInFileManager(mappedPath, revealOwner)
      }
    : null
  return {
    destination: mappedPath,
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
    ...(systemDefaultRow ? { alternate: systemDefaultRow } : {}),
    ...(revealRow ? { secondaryActions: [revealRow] } : {})
  }
}
