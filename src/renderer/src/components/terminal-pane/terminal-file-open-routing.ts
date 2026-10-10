import { absolutePathToFileUri } from '@/components/editor/markdown-internal-links'
import { getWorkspaceFilePreviewPlan, openFileInBrowserTab } from '@/lib/file-preview'
import { downloadAndOpenRemoteTerminalFile } from './terminal-remote-file-download-open'
import { detectLanguage } from '@/lib/language-detect'
import { findWorkspaceFileRoute } from '@/lib/runtime-workspace-file-route'
import { isPathInsideWorktree, toWorktreeRelativePath } from '@/lib/terminal-links'
import { canClientOsOpenWorkspaceFile } from '@/lib/workspace-file-host-routing'
import { isMissingRuntimePathError } from '@/runtime/runtime-file-client'
import { useAppStore } from '@/store'
import { activateAndRevealWorkspace, activateAndRevealWorktree } from '@/lib/worktree-activation'
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
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import { statUserOpenedPath } from '@/lib/user-opened-local-path'
import {
  CLIENT_LOCAL_FILE_TARGET,
  resolveHostWorkspaceFile,
  type HostWorkspaceFile
} from './terminal-host-workspace-file'
import { isFloatingWorkspaceId } from '../../../../shared/floating-workspace-worktree'

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
  /** Reports a path that could not be verified before opening; skipped once a later open supersedes it. */
  onOpenFailure?: (failure: FileOpenFailure) => void
}

export function isHtmlFilePath(filePath: string): boolean {
  return /\.html?$/i.test(filePath)
}

function openHtmlFileInBrowser(filePath: string, worktreeId: string, clientLocal: boolean): void {
  const store = useAppStore.getState()
  if (worktreeId) {
    // Why: following an HTML file link changes which worktree is foregrounded,
    // so it must record a history visit before opening the browser tab — but the
    // browser tab is the surface, so an emptied workspace must not gain a shell.
    activateAndRevealWorktree(worktreeId, { providesInitialSurface: true })
  }
  const fileUrl = absolutePathToFileUri(filePath)
  const title = filePath.split(/[/\\]/).pop() ?? filePath
  store.createBrowserTab(worktreeId, fileUrl, {
    title,
    activate: true,
    // Why: the file is on this computer, so the workspace's paired-server runtime must not adopt the page.
    ...(clientLocal ? { browserRuntimeEnvironmentId: null } : {})
  })
}

export function shouldOpenTerminalFileWithSystemDefault(fileContext: TerminalFileContext): boolean {
  // Why: an unresolved owner has no connectionId either, which would otherwise read as local.
  return fileContext.sourceHostResolved && canClientOsOpenWorkspaceFile(fileContext)
}

let latestOpenDetectedFilePathRequestId = 0
let pendingEditorRevealFrameIds: number[] = []

function cancelPendingEditorRevealFrames(): void {
  if (typeof cancelAnimationFrame === 'function') {
    for (const frameId of pendingEditorRevealFrameIds) {
      cancelAnimationFrame(frameId)
    }
  }
  pendingEditorRevealFrameIds = []
}

function schedulePendingEditorReveal(callback: () => void): void {
  cancelPendingEditorRevealFrames()
  const firstFrameId = requestAnimationFrame(() => {
    pendingEditorRevealFrameIds = pendingEditorRevealFrameIds.filter(
      (frameId) => frameId !== firstFrameId
    )
    const secondFrameId = requestAnimationFrame(() => {
      pendingEditorRevealFrameIds = pendingEditorRevealFrameIds.filter(
        (frameId) => frameId !== secondFrameId
      )
      callback()
    })
    pendingEditorRevealFrameIds.push(secondFrameId)
  })
  pendingEditorRevealFrameIds.push(firstFrameId)
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
  const requestId = ++latestOpenDetectedFilePathRequestId
  cancelPendingEditorRevealFrames()

  void (async () => {
    let statResult
    let fileContext = getTerminalFileContext(worktreeId, worktreePath, runtimeEnvironmentId)
    let hostWorkspaceFile: HostWorkspaceFile | null = null
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
      const linkOwner = await resolveHostWorkspaceFile(fileContext, mappedFilePath)
      if (linkOwner?.kind === 'client') {
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
      if (canOpenWithSystemDefault) {
        await window.api.shell.openFilePath(mappedFilePath, LOCAL_EXECUTION_HOST_ID)
      }
      return
    }

    if (openWithSystemDefault && !canOpenWithSystemDefault) {
      // Why: the popover names Shift+Cmd/Ctrl "Download & open with default app", and the OS
      // cannot launch a remote path, so the direct gesture must reach the same download.
      await downloadAndOpenRemoteTerminalFile(fileContext, mappedFilePath)
      return
    }

    // Why: local HTML files render in Orca's browser for ordinary Cmd/Ctrl-click,
    // and remain the fallback if Shift+Cmd/Ctrl cannot launch the OS default.
    if (isHtmlFilePath(mappedFilePath)) {
      if (canOpenWithSystemDefault) {
        openHtmlFileInBrowser(mappedFilePath, worktreeId, clientLocal)
        return
      }
      // Why: the same gesture renders remote HTML too, through the doc preview; only an
      // unsupported plan (e.g. a paired doc outside the worktree) falls back to source.
      const plan = getWorkspaceFilePreviewPlan(useAppStore.getState(), worktreeId, mappedFilePath)
      if (plan.status === 'doc-preview') {
        activateAndRevealWorktree(worktreeId, { providesInitialSurface: true })
        openFileInBrowserTab({ filePath: mappedFilePath, worktreeId })
        return
      }
    }

    const store = useAppStore.getState()
    let targetWorktreeId = worktreeId
    let targetExecutionHostId: ExecutionHostId | undefined = hostWorkspaceFile?.executionHostId
    let relativePath = mappedFilePath
    if (worktreePath && isPathInsideWorktree(mappedFilePath, worktreePath)) {
      const maybeRelative = toWorktreeRelativePath(mappedFilePath, worktreePath)
      // Why: a link out of the project keeps its absolute path, so the tab reads it as the file
      // the user named, before and after a restart, instead of being refused as a project file.
      if (maybeRelative !== null && maybeRelative.length > 0 && !statResult.escapesWorktree) {
        relativePath = maybeRelative
      }
    } else if (
      !isFloatingWorkspaceId(worktreeId) &&
      store.openFiles.some(
        (openFile) => openFile.filePath === mappedFilePath && openFile.worktreeId !== worktreeId
      )
    ) {
      // Why: early resolution is only needed to avoid an existing sibling-tab collision.
      const runtimeOwnerId = runtimeTargetEnvironmentId(fileContext.target)
      const executionHostId = runtimeOwnerId
        ? toRuntimeExecutionHostId(runtimeOwnerId)
        : getConnectionExecutionHostId(fileContext.connectionId)
      const siblingRoute = findWorkspaceFileRoute(store, executionHostId, mappedFilePath)
      if (siblingRoute) {
        targetWorktreeId = siblingRoute.worktreeId
        targetExecutionHostId = siblingRoute.executionHostId
        relativePath = siblingRoute.relativePath
      }
    }

    if (targetWorktreeId) {
      // Why: the route may name a folder-workspace key, and the same worktree id can exist
      // on several hosts — dispatch by workspace shape and keep the resolved host.
      activateAndRevealWorkspace(targetWorktreeId, {
        providesInitialSurface: true,
        ...(targetExecutionHostId ? { executionHostId: targetExecutionHostId } : {})
      })
    }

    const language = detectLanguage(mappedFilePath)
    store.openFile(
      {
        filePath: mappedFilePath,
        relativePath,
        worktreeId: targetWorktreeId || '',
        language,
        mode: 'edit',
        runtimeEnvironmentId: clientLocal ? null : runtimeEnvironmentId,
        // Why: a tab's owner must match its workspace's to be editable; this one is this computer's.
        ...(clientLocal && targetWorktreeId === worktreeId ? { readOnly: true } : {}),
        // Why: absolute SSH paths outside the worktree otherwise look identical
        // to client-local external files when the editor reloads or restores.
        ...(relativePath === filePath &&
        fileContext.target.kind === 'local' &&
        fileContext.connectionId
          ? { externalSshTargetId: fileContext.connectionId }
          : {})
      },
      { forceContentReload: true }
    )

    if (line !== null) {
      const openedStore = useAppStore.getState()
      // Why: scope the reveal to the opened editor tab id so owner-qualified tabs
      // across local/SSH/runtime contexts get it instead of an ambiguous path key.
      const fileId = openedStore.activeFileIdByWorktree[targetWorktreeId] ?? mappedFilePath
      if (language === 'markdown') {
        // Why: rich Markdown has no line-based reveal consumer; line links must mount Monaco.
        openedStore.setMarkdownViewMode(fileId, 'source')
      }
      const targetColumn = column ?? 1
      store.setPendingEditorReveal(null)
      schedulePendingEditorReveal(() => {
        if (requestId !== latestOpenDetectedFilePathRequestId) {
          return
        }
        store.setPendingEditorReveal({
          filePath: mappedFilePath,
          fileId,
          line,
          column: targetColumn,
          matchLength: 0
        })
      })
    }
  })()
}
