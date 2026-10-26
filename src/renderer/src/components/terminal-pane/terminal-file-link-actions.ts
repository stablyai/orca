import type { LinkActionRequest } from '@/components/link-actions/link-action-request'
import type { HttpLinkSourceOwner } from '@/lib/http-link-routing'
import { buildHttpLinkActions } from '@/lib/http-link-destinations'
import {
  getTerminalFileContext,
  mapTerminalFilePath,
  openDetectedFilePath,
  shouldOpenTerminalFileWithSystemDefault,
  terminalLinkWslDistro,
  type FileOpenFailure
} from './terminal-file-open-routing'
import { isHtmlFilePath, localHtmlFileDestinations } from './local-html-file-destinations'
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
import { canOpenLinkInSourceGroup } from '@/store/slices/editor/tabs/editor-open-target-group'

export type TerminalFileLinkActionDeps = {
  worktreeId: string
  worktreePath: string
  runtimeEnvironmentId?: string | null
  wslDistro?: string | null
  /** The paired-server terminal that printed the link; lets its host grant a file outside workspaces. */
  terminalHandle?: string | null
  onOpenFailure?: (failure: FileOpenFailure) => void
  /** The tab that owns the link; editor opens place themselves relative to its group. */
  sourceTabId?: string | null
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

  // Remote default-app opens download first because the OS can only launch local files.
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
        : // Hover is synchronous: avoid a remote stat per link. Unmarked directories fail visibly during download.
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
  // Omit remote reveal: rows have no disabled state and the file manager only shows local files.
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
  // Why: eligibility is unknown until the path resolves, so the row may still be refused then.
  const openInGroupRow =
    !worktreeRoot &&
    fileContext.sourceHostResolved &&
    canOpenLinkInSourceGroup(useAppStore.getState(), deps.worktreeId, deps.sourceTabId)
      ? {
          label: translate(
            'auto.components.terminal.pane.TerminalLinkActionPopover.openInThisGroup',
            'Open in this group'
          ),
          run: () =>
            openDetectedFilePath(filePath, line, column, {
              ...deps,
              openInSourceGroupSurface: 'internal'
            })
        }
      : null
  const secondaryActions = [openInGroupRow, revealRow].filter((row) => row !== null)
  const rows =
    !worktreeRoot && canOpenWithSystemDefault && isHtmlFilePath(mappedPath)
      ? buildHttpLinkActions(localHtmlFileDestinations(), (browserDestination) =>
          openDetectedFilePath(filePath, line, column, { ...deps, browserDestination })
        )
      : {
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
        }
  return {
    destination: mappedPath,
    kind: worktreeRoot ? 'workspace' : 'file',
    ...rows,
    ...(secondaryActions.length > 0 ? { secondaryActions } : {})
  }
}
