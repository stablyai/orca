import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { extractIpcErrorMessage } from '@/runtime/errors/ipc-error'
import { basename } from '@/lib/path'
import {
  downloadRuntimeFileToClient,
  isClientLocalRuntimeFile,
  openRuntimeFileWithDefaultApp
} from '@/runtime/files/reads/runtime-file-default-app-open'
import { showDownloadedFileToast } from '@/lib/files/download/downloaded-file-toast'
import { getRelativePathInsideWorktree } from '@/runtime/files/runtime-file-routing'
import { hostStreamsGrantedFiles } from '@/runtime/files/grants/runtime-terminal-artifact-grant'
import { isPairedWebClientWindow } from '@/app-shell/chrome/desktop-window-chrome'
import type {
  RuntimeFileOperationArgs,
  RuntimeFileReadArgs
} from '@/runtime/files/runtime-file-client-types'

type TerminalFileGrant = { terminalArtifactGrantId: string } | null | undefined

function linkFileReadSource(
  fileContext: RuntimeFileOperationArgs,
  filePath: string,
  grant: TerminalFileGrant
): RuntimeFileReadArgs {
  return {
    target: fileContext.target,
    filePath,
    relativePath: getRelativePathInsideWorktree(fileContext.worktreePath, filePath) ?? filePath,
    worktreeId: fileContext.worktreeId ?? undefined,
    connectionId: fileContext.connectionId,
    expectedExternalSshTargetId: fileContext.expectedExternalSshTargetId,
    expectedEnvironmentPairingRevision: fileContext.expectedEnvironmentPairingRevision,
    terminalArtifactGrantId: grant?.terminalArtifactGrantId
  }
}

function linkName(path: string): string {
  return basename(path) || path
}

function showDownloadFailedToast(error: unknown, name: string): void {
  toast.error(
    extractIpcErrorMessage(
      error,
      translate(
        'auto.components.terminal.pane.TerminalLinkActionPopover.downloadOpenFailed',
        "Failed to download '{{value0}}'.",
        { value0: name }
      )
    )
  )
}

function showAlreadyLocalToast(name: string): void {
  toast.info(
    translate(
      'auto.components.terminal.pane.TerminalLinkActionPopover.downloadAlreadyLocal',
      "'{{value0}}' is already on this computer.",
      { value0: name }
    )
  )
}

/**
 * Remote counterpart of "Open with default app": the OS can only launch a local
 * file, so the workspace copy is downloaded to a user-chosen path first.
 * False, before any download, for a granted file this client or its host cannot page; it opens in Orca instead.
 * True without a download when a newer click superseded this one.
 */
export async function downloadAndOpenRemoteTerminalFile(
  fileContext: RuntimeFileOperationArgs,
  filePath: string,
  { grant, isCurrent = () => true }: { grant?: TerminalFileGrant; isCurrent?: () => boolean } = {}
): Promise<boolean> {
  const { target, worktreeId } = fileContext
  if (grant) {
    if (
      // Why: a paired web client has no local file to stream into.
      isPairedWebClientWindow() ||
      target.kind !== 'environment' ||
      !worktreeId ||
      !(await hostStreamsGrantedFiles(target.environmentId))
    ) {
      // Why: a newer click made while the host answered owns the outcome, so a stale one falls back to nothing.
      return !isCurrent()
    }
    if (!isCurrent()) {
      return true
    }
  }
  try {
    await openRuntimeFileWithDefaultApp(linkFileReadSource(fileContext, filePath, grant))
  } catch (error) {
    showDownloadFailedToast(error, linkName(filePath))
  }
  return true
}

/** Saves a link's file to a path the user picks without opening it; a host that can't serve it is reported. */
export async function downloadRemoteTerminalFile(
  fileContext: RuntimeFileOperationArgs,
  filePath: string,
  grant: TerminalFileGrant
): Promise<void> {
  const name = linkName(filePath)
  try {
    const download = await downloadRuntimeFileToClient(
      linkFileReadSource(fileContext, filePath, grant)
    )
    if (!download) {
      showAlreadyLocalToast(name)
    } else if (!download.canceled) {
      showDownloadedFileToast(download.destinationPath)
    }
  } catch (error) {
    showDownloadFailedToast(error, name)
  }
}

/** Download-only for a folder link: no host serves a folder transfer, so a remote one is reported, not opened. */
export function downloadRemoteTerminalFolder(
  fileContext: Pick<RuntimeFileOperationArgs, 'target' | 'connectionId'>,
  folderPath: string
): void {
  const name = linkName(folderPath)
  if (isClientLocalRuntimeFile(fileContext)) {
    showAlreadyLocalToast(name)
    return
  }
  toast.error(
    translate(
      'auto.components.terminal.pane.TerminalLinkActionPopover.downloadFolderUnsupported',
      "Folder '{{value0}}' can't be downloaded from this host.",
      { value0: name }
    )
  )
}
