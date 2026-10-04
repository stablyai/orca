import { absolutePathToFileUri } from '@/components/editor/markdown-internal-links'
import { getWorkspaceFilePreviewPlan, openFileInBrowserTab } from '@/lib/file-preview'
import { downloadAndOpenRemoteTerminalFile } from './terminal-remote-file-download-open'
import { detectLanguage } from '@/lib/language-detect'
import { canClientOsOpenWorkspaceFile } from '@/lib/workspace-file-host-routing'
import { translate } from '@/i18n/i18n'
import {
  isMissingRuntimePathError,
  statRuntimePath,
  type RuntimeFileOperationArgs
} from '@/runtime/runtime-file-client'
import { useAppStore } from '@/store'
import { activateAndRevealWorkspace, activateAndRevealWorktree } from '@/lib/worktree-activation'
import { resolveKnownWorktreeRootPathLink } from './terminal-worktree-path-link'
import { resolveTerminalFileOwner, type TerminalFileOwner } from './terminal-file-owner'
import { resolveTerminalFileEditorTarget } from './terminal-file-editor-target'
import { parseWslUncPath, toWindowsWslPath } from '../../../../shared/wsl-paths'
import type { ExecutionHostId } from '../../../../shared/execution-host'

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

function openHtmlFileInBrowser(
  filePath: string,
  worktreeId: string,
  executionHostId?: ExecutionHostId
): void {
  const store = useAppStore.getState()
  if (worktreeId) {
    // Why: following an HTML file link changes which worktree is foregrounded,
    // so it must record a history visit before opening the browser tab — but the
    // browser tab is the surface, so an emptied workspace must not gain a shell.
    activateAndRevealWorktree(worktreeId, {
      providesInitialSurface: true,
      ...(executionHostId ? { executionHostId } : {})
    })
  }
  const fileUrl = absolutePathToFileUri(filePath)
  const title = filePath.split(/[/\\]/).pop() ?? filePath
  // Why explicitly client-hosted: a file:// URL names this machine's disk, so a runtime workspace
  // must not hand the page to its runtime, whose browser would load the server's path instead.
  store.createBrowserTab(worktreeId, fileUrl, {
    title,
    activate: true,
    browserRuntimeEnvironmentId: null
  })
}

export function getTerminalFileContext(
  worktreeId: string,
  worktreePath: string,
  runtimeEnvironmentId: string | null | undefined,
  filePath: string
): RuntimeFileOperationArgs {
  return resolveTerminalFileOwner(worktreeId, worktreePath, runtimeEnvironmentId, filePath)
    .fileContext
}

function toFileOpenFailure(owner: TerminalFileOwner, error: unknown): FileOpenFailure {
  if (!isMissingRuntimePathError(error)) {
    // Why: loss of contact with the host is not evidence the file is gone.
    return { verdict: 'unverifiable', error }
  }
  // Why: absent here proves nothing about the runtime, which just cannot serve this path.
  return owner.kind === 'client'
    ? {
        verdict: 'unverifiable',
        error: new Error(
          translate(
            'components.native-chat.fileLinks.outsideRuntimeWorkspace',
            'Not on this computer, and the remote host opens files only inside its workspaces'
          )
        )
      }
    : { verdict: 'missing', error }
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
  return canClientOsOpenWorkspaceFile(fileContext, filePath)
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
    const owner = resolveTerminalFileOwner(
      worktreeId,
      worktreePath,
      runtimeEnvironmentId,
      mappedFilePath
    )
    const { fileContext } = owner
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
    } catch (error) {
      if (requestId === latestOpenDetectedFilePathRequestId && deps.onOpenFailure) {
        deps.onOpenFailure(toFileOpenFailure(owner, error))
      }
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

    if (openWithSystemDefault && !canOpenWithSystemDefault) {
      // Why: the popover names Shift+Cmd/Ctrl "Download & open with default app", and the OS
      // cannot launch a remote path, so the direct gesture must reach the same download.
      await downloadAndOpenRemoteTerminalFile(fileContext, mappedFilePath)
      return
    }

    // Why: local HTML files render in Orca's browser for ordinary Cmd/Ctrl-click,
    // and remain the fallback if Shift+Cmd/Ctrl cannot launch the OS default.
    if (isHtmlFilePath(mappedFilePath)) {
      if (shouldOpenTerminalFileWithSystemDefault(fileContext, mappedFilePath)) {
        openHtmlFileInBrowser(
          mappedFilePath,
          worktreeId,
          owner.kind === 'client' ? owner.paneExecutionHostId : undefined
        )
        return
      }
      // Why: the same gesture renders remote HTML too, through the doc preview; only an
      // unsupported plan (e.g. a paired doc outside the worktree) falls back to source.
      const previewWorktreeId =
        owner.kind === 'runtime-sibling' ? owner.route.worktreeId : worktreeId
      const plan = getWorkspaceFilePreviewPlan(
        useAppStore.getState(),
        previewWorktreeId,
        mappedFilePath
      )
      if (plan.status === 'doc-preview') {
        if (owner.kind === 'runtime-sibling') {
          activateAndRevealWorkspace(previewWorktreeId, {
            providesInitialSurface: true,
            executionHostId: owner.route.executionHostId
          })
        } else {
          activateAndRevealWorktree(worktreeId, { providesInitialSurface: true })
        }
        openFileInBrowserTab({ filePath: mappedFilePath, worktreeId: previewWorktreeId })
        return
      }
    }

    const store = useAppStore.getState()
    const target = resolveTerminalFileEditorTarget(store, owner, mappedFilePath, deps)
    const targetWorktreeId = target.worktreeId
    const relativePath = target.relativePath

    if (targetWorktreeId) {
      // Why: the route may name a folder-workspace key, and the same worktree id can exist
      // on several hosts — dispatch by workspace shape and keep the resolved host.
      activateAndRevealWorkspace(targetWorktreeId, {
        providesInitialSurface: true,
        ...(target.executionHostId ? { executionHostId: target.executionHostId } : {})
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
        runtimeEnvironmentId: target.runtimeEnvironmentId,
        ...(target.readOnly ? { readOnly: true } : {}),
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
