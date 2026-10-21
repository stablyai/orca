import { openWorkspaceFile } from '@/lib/workspace-file-open'
import { downloadAndOpenRemoteTerminalFile } from './terminal-remote-file-download-open'
import { findWorkspaceFileRoute } from '@/lib/runtime-workspace-file-route'
import { isPathInsideWorktree, toWorktreeRelativePath } from '@/lib/terminal-links'
import { canClientOsOpenWorkspaceFile } from '@/lib/workspace-file-host-routing'
import { isMissingRuntimePathError } from '@/runtime/runtime-file-metadata-client'
import { useAppStore } from '@/store'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { resolveKnownWorktreeRootPathLink } from './terminal-worktree-path-link'
import {
  getTerminalFileContext,
  mapTerminalFilePath,
  terminalLinkWslDistro,
  type TerminalFileContext
} from './terminal-file-path-mapping'
import {
  LOCAL_EXECUTION_HOST_ID,
  getConnectionExecutionHostId,
  toRuntimeExecutionHostId
} from '../../../../shared/execution-host'
import { statUserOpenedPath } from '@/lib/user-opened-local-path'
import {
  CLIENT_LOCAL_FILE_TARGET,
  resolveHostWorkspaceFile,
  type HostWorkspaceFile
} from './terminal-host-workspace-file'
import { isFloatingWorkspaceId } from '../../../../shared/floating-workspace-worktree'
import { captureEditorOpenLinkIntent } from '@/store/slices/editor/tabs/editor-open-target-group'
import { cancelPendingEditorLineRevealFrames } from '@/store/slices/editor/focus/editor-focus-reveal'
import { showOpenInGroupRefusedToast } from './terminal-file-open-in-group-toast'
import { isExplicitEditorScopeKept } from '@/lib/editor-file-link-open'

export {
  getTerminalFileContext,
  mapTerminalFilePath,
  terminalLinkWslDistro,
  terminalPathWslDistro,
  type TerminalFileContext
} from './terminal-file-path-mapping'
import { runtimeTargetEnvironmentId } from '@/runtime/runtime-client-target'

export type FileOpenFailure = {
  /** `missing` is a verified absence; `unverifiable` means the host could not answer (dropped SSH, timeout, denied path). */
  verdict: 'missing' | 'unverifiable'
  error: unknown
}

type TerminalFileOpenDeps = {
  worktreeId: string
  worktreePath: string
  runtimeEnvironmentId?: string | null
  wslDistro?: string | null
  openWithSystemDefault?: boolean
  /** The paired-server terminal that printed the link; lets its host grant a file outside workspaces. */
  terminalHandle?: string | null
  /** Reports a path that could not be verified before opening; skipped once a later open supersedes it. */
  onOpenFailure?: (failure: FileOpenFailure) => void
  /** The tab that owns the link; editor opens place themselves relative to its group. */
  sourceTabId?: string | null
  /** "Open in this group": pins the source tab's group at activation, or refuses. */
  openInSourceGroup?: boolean
}

export function shouldOpenTerminalFileWithSystemDefault(fileContext: TerminalFileContext): boolean {
  // Why: an unresolved owner has no connectionId either, which would otherwise read as local.
  return fileContext.sourceHostResolved && canClientOsOpenWorkspaceFile(fileContext)
}

let latestOpenDetectedFilePathRequestId = 0

export function openDetectedFilePath(
  filePath: string,
  line: number | null,
  column: number | null,
  deps: TerminalFileOpenDeps
): void {
  const { openWithSystemDefault = false, runtimeEnvironmentId } = deps
  let { worktreeId, worktreePath } = deps
  let mappedFilePath = mapTerminalFilePath(
    filePath,
    worktreePath,
    terminalLinkWslDistro(deps.wslDistro, runtimeEnvironmentId)
  )
  const requestId = ++latestOpenDetectedFilePathRequestId
  cancelPendingEditorLineRevealFrames()
  // Why: capture at activation; focus may move while the host resolves the path.
  const linkIntent = captureEditorOpenLinkIntent(
    useAppStore.getState(),
    deps.worktreeId,
    deps.sourceTabId,
    { explicitSourceGroup: deps.openInSourceGroup === true }
  )
  const explicitGroupRequest = deps.openInSourceGroup === true
  // Why: an explicit group request never substitutes a browser, system app, or download.
  const refuseExplicitNonEditorRoute = (): boolean => {
    if (!explicitGroupRequest) {
      return false
    }
    if (requestId === latestOpenDetectedFilePathRequestId) {
      showOpenInGroupRefusedToast(mappedFilePath)
    }
    return true
  }

  void (async () => {
    let statResult
    let fileContext = getTerminalFileContext(worktreeId, worktreePath, runtimeEnvironmentId)
    const sourceRuntimeOwnerId = runtimeTargetEnvironmentId(fileContext.target)
    let hostWorkspaceFile: HostWorkspaceFile | null = null
    let hostGrantId: string | null = null
    let clientLocal = false
    if (!fileContext.sourceHostResolved) {
      // Why: with no owner the host is unknown — refuse rather than touch this machine's files.
      deps.onOpenFailure?.({
        verdict: 'unverifiable',
        error: new Error('The terminal workspace host could not be determined')
      })
      return
    }
    if (!openWithSystemDefault) {
      const worktreeRootLink = resolveKnownWorktreeRootPathLink(
        mappedFilePath,
        useAppStore.getState(),
        fileContext
      )
      if (worktreeRootLink) {
        if (refuseExplicitNonEditorRoute()) {
          return
        }
        // Why: root workspace switching must work for SSH/runtime paths without
        // local auth/stat, while still coalescing provider + fallback clicks.
        await Promise.resolve()
        if (requestId !== latestOpenDetectedFilePathRequestId) {
          return
        }
        activateAndRevealWorktree(worktreeRootLink.id, {
          executionHostId: worktreeRootLink.executionHostId
        })
        return
      }
    }

    try {
      const linkOwner = await resolveHostWorkspaceFile(
        fileContext,
        mappedFilePath,
        deps.terminalHandle
      )
      if (linkOwner?.kind === 'grant') {
        hostGrantId = linkOwner.grantId
        mappedFilePath = linkOwner.absolutePath
        statResult = { isDirectory: false, escapesWorktree: true }
      } else if (linkOwner?.kind === 'client') {
        clientLocal = true
        fileContext = {
          ...fileContext,
          target: CLIENT_LOCAL_FILE_TARGET,
          connectionId: undefined
        }
        statResult = { isDirectory: linkOwner.isDirectory, escapesWorktree: false }
      } else if (linkOwner) {
        hostWorkspaceFile = linkOwner
        // Why: the host already stat'ed the path inside the workspace that holds it; open it there.
        ;({ worktreeId, worktreePath, absolutePath: mappedFilePath } = hostWorkspaceFile)
        fileContext = { ...fileContext, worktreeId, worktreePath }
        statResult = { isDirectory: hostWorkspaceFile.isDirectory, escapesWorktree: false }
      } else {
        statResult = await statUserOpenedPath(fileContext, mappedFilePath)
      }
    } catch (error) {
      if (requestId === latestOpenDetectedFilePathRequestId && deps.onOpenFailure) {
        // Why: loss of contact with the host is not evidence the file is gone.
        deps.onOpenFailure({
          verdict: isMissingRuntimePathError(error) ? 'missing' : 'unverifiable',
          error
        })
      }
      return
    }

    if (requestId !== latestOpenDetectedFilePathRequestId) {
      return
    }

    const canOpenWithSystemDefault = shouldOpenTerminalFileWithSystemDefault(fileContext)
    if (openWithSystemDefault && canOpenWithSystemDefault) {
      // Why: Shift+Cmd/Ctrl mirrors URL links by escaping Orca and honoring the
      // user's OS file associations without adding editor-specific settings.
      const openedWithSystemDefault = await window.api.shell.openFilePath(
        mappedFilePath,
        LOCAL_EXECUTION_HOST_ID
      )
      if (openedWithSystemDefault || statResult.isDirectory) {
        return
      }
    }

    if (statResult.isDirectory) {
      if (refuseExplicitNonEditorRoute()) {
        return
      }
      if (canOpenWithSystemDefault) {
        await window.api.shell.openFilePath(mappedFilePath, LOCAL_EXECUTION_HOST_ID)
      }
      return
    }

    // Why: a granted file is readable only through its grant, so it opens in Orca, never as a download.
    if (openWithSystemDefault && !canOpenWithSystemDefault && hostGrantId === null) {
      // Why: the popover names Shift+Cmd/Ctrl "Download & open with default app", and the OS
      // cannot launch a remote path, so the direct gesture must reach the same download.
      await downloadAndOpenRemoteTerminalFile(fileContext, mappedFilePath)
      return
    }

    const store = useAppStore.getState()
    let targetWorktreeId = worktreeId
    const runtimeOwnerId = runtimeTargetEnvironmentId(fileContext.target) ?? sourceRuntimeOwnerId
    let targetExecutionHostId =
      hostWorkspaceFile?.executionHostId ??
      (runtimeOwnerId
        ? toRuntimeExecutionHostId(runtimeOwnerId)
        : getConnectionExecutionHostId(fileContext.connectionId))
    let relativePath = mappedFilePath
    if (worktreePath && isPathInsideWorktree(mappedFilePath, worktreePath)) {
      const maybeRelative = toWorktreeRelativePath(mappedFilePath, worktreePath)
      // Why: a link out of the project keeps its absolute path, so the tab reads it as the file
      // the user named, before and after a restart, instead of being refused as a project file.
      if (maybeRelative !== null && maybeRelative.length > 0 && !statResult.escapesWorktree) {
        relativePath = maybeRelative
      }
    } else if (
      hostGrantId === null &&
      !isFloatingWorkspaceId(worktreeId) &&
      store.openFiles.some(
        (openFile) => openFile.filePath === mappedFilePath && openFile.worktreeId !== worktreeId
      )
    ) {
      // Why: early resolution is only needed to avoid an existing sibling-tab collision.
      const siblingRoute = findWorkspaceFileRoute(store, targetExecutionHostId, mappedFilePath)
      if (siblingRoute) {
        targetWorktreeId = siblingRoute.worktreeId
        targetExecutionHostId = siblingRoute.executionHostId
        relativePath = siblingRoute.relativePath
      }
    }

    if (
      explicitGroupRequest &&
      !isExplicitEditorScopeKept(linkIntent, targetWorktreeId, targetExecutionHostId, clientLocal)
    ) {
      // Why: refuse before activating the destination or touching editor state.
      refuseExplicitNonEditorRoute()
      return
    }

    const opened = openWorkspaceFile({
      kind: 'link',
      executionHostId: targetExecutionHostId,
      clientLocal,
      file: {
        filePath: mappedFilePath,
        relativePath,
        worktreeId: targetWorktreeId || '',
        runtimeEnvironmentId: clientLocal ? null : runtimeEnvironmentId,
        // Why: a tab's owner must match its workspace's to be editable; this one is this computer's.
        ...(clientLocal && targetWorktreeId === worktreeId ? { readOnly: true } : {}),
        // Why: the grant is the only authority to read a host file outside its workspaces.
        ...(hostGrantId !== null ? { readOnly: true, terminalArtifactGrantId: hostGrantId } : {}),
        // Why: absolute SSH paths outside the worktree otherwise look identical
        // to client-local external files when the editor reloads or restores.
        ...(relativePath === filePath &&
        fileContext.target.kind === 'local' &&
        fileContext.connectionId
          ? { externalSshTargetId: fileContext.connectionId }
          : {})
      },
      linkIntent,
      position: { line, column },
      isCurrentRequest: () => requestId === latestOpenDetectedFilePathRequestId
    })
    if (opened.surface === 'refused') {
      refuseExplicitNonEditorRoute()
    }
  })()
}
