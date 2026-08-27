import { absolutePathToFileUri } from '@/components/editor/markdown-internal-links'
import { getConnectionId } from '@/lib/connection-context'
import { detectLanguage } from '@/lib/language-detect'
import { findWorkspaceFileRoute } from '@/lib/runtime-workspace-file-route'
import { isPathInsideWorktree, toWorktreeRelativePath } from '@/lib/terminal-links'
import {
  isRemoteRuntimeFileOperation,
  statRuntimePath,
  type RuntimeFileOperationArgs
} from '@/runtime/runtime-file-client'
import { settingsForRuntimeOwner } from '@/runtime/runtime-rpc-client'
import { useAppStore } from '@/store'
import { activateAndRevealWorkspace, activateAndRevealWorktree } from '@/lib/worktree-activation'
import { resolveKnownWorktreeRootPathLink } from './terminal-worktree-path-link'
import { parseWslUncPath, toWindowsWslPath } from '../../../../shared/wsl-paths'
import {
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'

type TerminalFileOpenDeps = {
  worktreeId: string
  worktreePath: string
  runtimeEnvironmentId?: string | null
  wslDistro?: string | null
  openWithSystemDefault?: boolean
}

export function isHtmlFilePath(filePath: string): boolean {
  return /\.html?$/i.test(filePath)
}

function openHtmlFileInBrowser(filePath: string, worktreeId: string): void {
  const store = useAppStore.getState()
  if (worktreeId) {
    // Why: following an HTML file link changes which worktree is foregrounded,
    // so it must record a history visit before opening the browser tab — but the
    // browser tab is the surface, so an emptied workspace must not gain a shell.
    activateAndRevealWorktree(worktreeId, { providesInitialSurface: true })
  }
  const fileUrl = absolutePathToFileUri(filePath)
  const title = filePath.split(/[/\\]/).pop() ?? filePath
  store.createBrowserTab(worktreeId, fileUrl, { title, activate: true })
}

export function getTerminalFileContext(
  worktreeId: string,
  worktreePath: string,
  runtimeEnvironmentId?: string | null
): RuntimeFileOperationArgs {
  const settings = useAppStore.getState().settings
  return {
    settings: settingsForRuntimeOwner(settings, runtimeEnvironmentId),
    worktreeId: worktreeId || null,
    worktreePath,
    connectionId: getConnectionId(worktreeId || null) ?? undefined
  }
}

// Why: a WSL-runtime pane prints POSIX paths even when the worktree lives on a
// Windows drive, so the distro must come from the pane runtime, not the path shape.
export function mapTerminalFilePath(
  filePath: string,
  worktreePath: string,
  wslDistro?: string | null
): string {
  const distro =
    wslDistro === null ? null : wslDistro?.trim() || parseWslUncPath(worktreePath)?.distro
  if (!distro || !filePath.startsWith('/')) {
    return filePath
  }
  // Why: only a proven local WSL pane may reinterpret this POSIX-looking path; SSH/runtime paths stay literal.
  const alreadyUnc = parseWslUncPath(filePath)
  if (alreadyUnc) {
    return toWindowsWslPath(alreadyUnc.linuxPath, alreadyUnc.distro)
  }
  if (filePath.startsWith('//')) {
    return filePath
  }
  // Why: /mnt/<drive> is a Windows drive mounted into WSL — reach it directly
  // instead of routing a native file back through the 9P share.
  return toWindowsWslPath(filePath, distro)
}

// Why: remote-runtime panes print the remote host's POSIX paths; the local WSL
// distro must never rewrite them.
export function terminalLinkWslDistro(
  wslDistro: string | null | undefined,
  runtimeEnvironmentId: string | null | undefined
): string | null | undefined {
  return runtimeEnvironmentId ? null : wslDistro
}

export function shouldOpenTerminalFileWithSystemDefault(
  fileContext: RuntimeFileOperationArgs,
  filePath: string
): boolean {
  return !fileContext.connectionId && !isRemoteRuntimeFileOperation(fileContext, filePath)
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
  const { openWithSystemDefault = false, runtimeEnvironmentId, worktreeId, worktreePath } = deps
  const mappedFilePath = mapTerminalFilePath(
    filePath,
    worktreePath,
    terminalLinkWslDistro(deps.wslDistro, runtimeEnvironmentId)
  )
  const requestId = ++latestOpenDetectedFilePathRequestId
  cancelPendingEditorRevealFrames()

  void (async () => {
    let statResult
    const fileContext = getTerminalFileContext(worktreeId, worktreePath, runtimeEnvironmentId)
    const canOpenWithSystemDefault = shouldOpenTerminalFileWithSystemDefault(
      fileContext,
      mappedFilePath
    )

    if (!openWithSystemDefault) {
      const worktreeRootLink = resolveKnownWorktreeRootPathLink(mappedFilePath)
      if (worktreeRootLink) {
        // Why: root workspace switching must work for SSH/runtime paths without
        // local auth/stat, while still coalescing provider + fallback clicks.
        await Promise.resolve()
        if (requestId !== latestOpenDetectedFilePathRequestId) {
          return
        }
        activateAndRevealWorktree(worktreeRootLink.id)
        return
      }
    }

    try {
      // Why: remote paths don't need local auth — the relay/runtime is the security boundary.
      if (canOpenWithSystemDefault) {
        await window.api.fs.authorizeExternalPath({ targetPath: mappedFilePath })
      }
      statResult = await statRuntimePath(fileContext, mappedFilePath)
    } catch {
      return
    }

    if (requestId !== latestOpenDetectedFilePathRequestId) {
      return
    }

    if (openWithSystemDefault && canOpenWithSystemDefault) {
      // Why: Shift+Cmd/Ctrl mirrors URL links by escaping Orca and honoring the
      // user's OS file associations without adding editor-specific settings.
      const openedWithSystemDefault = await window.api.shell.openFilePath(mappedFilePath)
      if (openedWithSystemDefault || statResult.isDirectory) {
        return
      }
    }

    if (statResult.isDirectory) {
      if (canOpenWithSystemDefault) {
        await window.api.shell.openFilePath(mappedFilePath)
      }
      return
    }

    // Why: local HTML files render in Orca's browser for ordinary Cmd/Ctrl-click,
    // and remain the fallback if Shift+Cmd/Ctrl cannot launch the OS default.
    if (
      isHtmlFilePath(mappedFilePath) &&
      shouldOpenTerminalFileWithSystemDefault(fileContext, mappedFilePath)
    ) {
      openHtmlFileInBrowser(mappedFilePath, worktreeId)
      return
    }

    const store = useAppStore.getState()
    let targetWorktreeId = worktreeId
    let targetExecutionHostId: ExecutionHostId | undefined
    let relativePath = mappedFilePath
    if (worktreePath && isPathInsideWorktree(mappedFilePath, worktreePath)) {
      const maybeRelative = toWorktreeRelativePath(mappedFilePath, worktreePath)
      if (maybeRelative !== null && maybeRelative.length > 0) {
        relativePath = maybeRelative
      }
    } else if (
      store.openFiles.some(
        (openFile) => openFile.filePath === mappedFilePath && openFile.worktreeId !== worktreeId
      )
    ) {
      // Why: early resolution is only needed to avoid an existing sibling-tab collision.
      const runtimeOwnerId = fileContext.settings?.activeRuntimeEnvironmentId?.trim()
      const executionHostId = runtimeOwnerId
        ? toRuntimeExecutionHostId(runtimeOwnerId)
        : fileContext.connectionId
          ? toSshExecutionHostId(fileContext.connectionId)
          : LOCAL_EXECUTION_HOST_ID
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
        runtimeEnvironmentId,
        // Why: absolute SSH paths outside the worktree otherwise look identical
        // to client-local external files when the editor reloads or restores.
        ...(relativePath === filePath &&
        !fileContext.settings?.activeRuntimeEnvironmentId?.trim() &&
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
