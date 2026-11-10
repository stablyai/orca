import { downloadAndOpenRemoteTerminalFile } from './terminal-remote-file-download-open'
import { isMissingRuntimePathError } from '@/runtime/files/metadata/runtime-file-metadata-client'
import { useAppStore } from '@/store/index'
import {
  activateAndRevealWorkspace,
  activateAndRevealWorktree
} from '@/lib/workspace/activation/worktree-activation'
import {
  resolveKnownWorktreeRootPathLink,
  terminalFileSourceHost
} from './terminal-worktree-path-link'
import {
  getTerminalFileContext,
  mapTerminalFilePath,
  shouldOpenTerminalFileWithSystemDefault,
  terminalLinkWslDistro
} from '../../host-files/terminal-file-path-mapping'
import {
  LOCAL_EXECUTION_HOST_ID,
  getConnectionExecutionHostId
} from '../../../../../../shared/execution-host'
import { statUserOpenedPath } from '@/lib/files/access/user-opened-local-path'
import {
  CLIENT_LOCAL_FILE_TARGET,
  hostGrantedEditorFields,
  resolveHostWorkspaceFile
} from '../../host-files/terminal-host-workspace-file'
import type { HostWorkspaceFile } from '../../host-files/terminal-host-workspace-file'
import { captureEditorOpenLinkIntent } from '@/store/slices/editor/tabs/editor-open-target-group'
import { beginLinkOpenRequest as reserveDetectedFilePathOpenTurn } from '@/lib/links/link-open-request'
import { openTerminalHtmlFileInBrowser } from './terminal-file-link-browser-open'
import { refuseOpenInGroupRequest } from './terminal-file-open-in-group-toast'
import { isExplicitEditorScopeKept, openLinkedFileInEditor } from './terminal-file-link-editor-open'
import { resolveLinkedFileEditorTarget } from '../../host-files/terminal-file-editor-target'
import { runtimeTargetEnvironmentId } from '@/runtime/rpc/targets/runtime-client-target'
import { httpLinkDirectClickDestination } from '@/lib/browser/navigation/http-link-destinations'
import type { HttpLinkDestination } from '@/lib/browser/navigation/http-link-destinations'
import { isHtmlFilePath, localHtmlFileDestinations } from './local-html-file-destinations'
import type { FileOpenFailure } from './terminal-file-open-failure'
import { openDetectedFolder } from './terminal-folder-open'

type TerminalFileOpenDeps = {
  worktreeId: string
  worktreePath: string
  runtimeEnvironmentId?: string | null
  wslDistro?: string | null
  /** Shift+modifier: the OS default app, or the other link-routing browser for a local HTML file. */
  openWithSystemDefault?: boolean
  /** Where a local HTML file opens, chosen from its popover; otherwise link routing decides. */
  browserDestination?: HttpLinkDestination
  /** The paired-server terminal that printed the link; lets its host grant a file outside workspaces. */
  terminalHandle?: string | null
  hostFileOnly?: boolean
  /** Reports a path that could not be verified before opening; skipped once a later open supersedes it. */
  onOpenFailure?: (failure: FileOpenFailure) => void
  /** The tab that owns the link; editor opens place themselves relative to its group. */
  sourceTabId?: string | null
  /** "Open in new tab": pins the source tab's group at activation, or refuses. */
  openInSourceGroup?: boolean
  /** Opt-in menu request; the legacy flag remains editor-only. */
  openInSourceGroupSurface?: 'internal' | 'browser'
}

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
  const isCurrentRequest = reserveDetectedFilePathOpenTurn()
  const explicitGroupRequest =
    deps.openInSourceGroup === true || deps.openInSourceGroupSurface !== undefined
  // Why: capture at activation; focus may move while the host resolves the path.
  const linkIntent = captureEditorOpenLinkIntent(
    useAppStore.getState(),
    deps.worktreeId,
    deps.sourceTabId,
    { explicitSourceGroup: explicitGroupRequest }
  )
  const refuseExplicitNonEditorRoute = (): boolean =>
    refuseOpenInGroupRequest(mappedFilePath, explicitGroupRequest, isCurrentRequest)
  const linkContext = deps.sourceTabId ? { linkIntent, isCurrentRequest } : undefined
  if (explicitGroupRequest && !linkIntent) {
    refuseExplicitNonEditorRoute()
    return
  }

  void (async () => {
    let statResult
    let fileContext = getTerminalFileContext(worktreeId, worktreePath, runtimeEnvironmentId)
    const sourceFileHostId =
      terminalFileSourceHost(useAppStore.getState(), fileContext) ??
      getConnectionExecutionHostId(fileContext.connectionId)
    const sourceRuntimeOwnerId = runtimeTargetEnvironmentId(fileContext.target)
    let hostWorkspaceFile: HostWorkspaceFile | null = null
    let hostGrant: ReturnType<typeof hostGrantedEditorFields> | null = null
    let clientLocal = false
    if (!fileContext.sourceHostResolved) {
      if (refuseExplicitNonEditorRoute()) {
        return
      }
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
        // Switch root workspace for SSH/runtime paths without local auth/stat; coalesce provider and fallback clicks.
        await Promise.resolve()
        if (!isCurrentRequest()) {
          return
        }
        activateAndRevealWorktree(worktreeRootLink.id, {
          executionHostId: worktreeRootLink.executionHostId
        })
        return
      }
    }

    try {
      const linkOwner = await resolveHostWorkspaceFile(fileContext, mappedFilePath, deps)
      if (linkOwner?.kind === 'grant') {
        hostGrant = hostGrantedEditorFields(linkOwner)
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
      if (isCurrentRequest() && deps.onOpenFailure) {
        // Why: loss of contact with the host is not evidence the file is gone.
        deps.onOpenFailure({
          verdict: isMissingRuntimePathError(error) ? 'missing' : 'unverifiable',
          error
        })
      }
      return
    }

    if (!isCurrentRequest()) {
      return
    }

    const canOpenWithSystemDefault = shouldOpenTerminalFileWithSystemDefault(fileContext)
    if (explicitGroupRequest && openWithSystemDefault) {
      refuseExplicitNonEditorRoute()
      return
    }
    // Remote hints promise Orca before resolution; explicit group requests must reach HTML branch to be refused.
    const pageDestination =
      canOpenWithSystemDefault &&
      !clientLocal &&
      hostGrant === null &&
      !explicitGroupRequest &&
      isHtmlFilePath(mappedFilePath)
        ? (deps.browserDestination ??
          httpLinkDirectClickDestination(localHtmlFileDestinations(), openWithSystemDefault))
        : null
    const opensWithSystemDefault = pageDestination
      ? pageDestination === 'system'
      : openWithSystemDefault
    if (opensWithSystemDefault && canOpenWithSystemDefault) {
      // Shift+Cmd/Ctrl follows URL-link behavior and OS file associations without new editor settings.
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
      await openDetectedFolder({
        folderPath: mappedFilePath,
        worktreeId,
        worktreePath,
        hostWorkspaceFile,
        environmentOwned: fileContext.target.kind === 'environment',
        sourceHostId: sourceFileHostId,
        openWithSystemDefault: canOpenWithSystemDefault,
        onFailure: (failure) => deps.onOpenFailure?.(failure)
      })
      return
    }

    // Shift+Cmd/Ctrl must match popover’s Download & open with default app; OS cannot directly launch remote paths.
    if (openWithSystemDefault && !canOpenWithSystemDefault) {
      const download = { grant: hostGrant, isCurrent: isCurrentRequest }
      if (await downloadAndOpenRemoteTerminalFile(fileContext, mappedFilePath, download)) {
        return
      }
    }

    // Route local HTML to Orca browser, including system-browser opens OS could not launch.
    // Why: a read-only grant comes from a host that re-grants only to the printing terminal, so preview reads would fail.
    if (isHtmlFilePath(mappedFilePath) && !hostGrant?.readOnly) {
      if (deps.openInSourceGroup) {
        refuseExplicitNonEditorRoute()
        return
      }
      const fileExecutionHostId = hostWorkspaceFile?.executionHostId ?? sourceFileHostId
      if (
        openTerminalHtmlFileInBrowser({
          filePath: mappedFilePath,
          worktreeId,
          clientLocal,
          canOpenWithSystemDefault,
          ...(linkContext && !clientLocal ? { fileExecutionHostId } : {}),
          linkContext,
          ...(explicitGroupRequest ? { refuseOpenInSourceGroup: refuseExplicitNonEditorRoute } : {})
        })
      ) {
        return
      }
    }

    if (deps.openInSourceGroupSurface === 'browser') {
      refuseExplicitNonEditorRoute()
      return
    }

    const {
      worktreeId: targetWorktreeId,
      executionHostId: targetExecutionHostId,
      relativePath
    } = resolveLinkedFileEditorTarget({
      filePath: mappedFilePath,
      worktreeId,
      worktreePath,
      fileContext,
      sourceRuntimeOwnerId,
      hostExecutionHostId: hostWorkspaceFile?.executionHostId,
      granted: hostGrant !== null,
      escapesWorktree: statResult.escapesWorktree
    })

    if (
      explicitGroupRequest &&
      !isExplicitEditorScopeKept(linkIntent, targetWorktreeId, targetExecutionHostId, clientLocal)
    ) {
      // Why: refuse before activating the destination or touching editor state.
      refuseExplicitNonEditorRoute()
      return
    }

    if (targetWorktreeId) {
      // Route by workspace shape and resolved host: folder keys are valid and worktree ids can repeat across hosts.
      activateAndRevealWorkspace(targetWorktreeId, {
        providesInitialSurface: true,
        executionHostId: targetExecutionHostId
      })
    }

    const opened = openLinkedFileInEditor(
      {
        filePath: mappedFilePath,
        relativePath,
        worktreeId: targetWorktreeId || '',
        runtimeEnvironmentId: clientLocal ? null : runtimeEnvironmentId,
        // Why: a tab's owner must match its workspace's to be editable; this one is this computer's.
        ...(clientLocal && targetWorktreeId === worktreeId ? { readOnly: true } : {}),
        ...hostGrant,
        // Retain SSH owner or restored absolute remote paths become indistinguishable from client-local external files.
        ...(relativePath === filePath &&
        fileContext.target.kind === 'local' &&
        fileContext.connectionId
          ? { externalSshTargetId: fileContext.connectionId }
          : {})
      },
      linkIntent,
      { line, column },
      isCurrentRequest
    )
    if (!opened) {
      refuseExplicitNonEditorRoute()
    }
  })()
}
