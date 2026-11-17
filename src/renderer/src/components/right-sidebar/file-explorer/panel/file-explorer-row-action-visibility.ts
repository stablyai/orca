import type { RuntimeFileOperationArgs } from '@/runtime/files/runtime-file-client-types'
import type { TreeNode } from '../tree/file-explorer-types'
import { canOpenRuntimeDownloadLocally } from '../../../../../../shared/runtime-downloads/runtime-download-contract'

export function shouldShowCollapseFolderAction(node: TreeNode, isExpanded: boolean): boolean {
  return node.isDirectory && isExpanded
}

export function shouldShowFindInFolderAction(node: TreeNode): boolean {
  return node.isDirectory
}

export function shouldShowOpenInTerminalAction(node: TreeNode): boolean {
  return node.isDirectory
}

export function shouldShowViewFileAction(node: TreeNode): boolean {
  return !node.isDirectory
}

export function shouldShowRemoteDownloadAction(
  node: TreeNode,
  connectionId?: string | null,
  runtimeDownloadContext?: RuntimeFileOperationArgs | null,
  // Require advertised SFTP recursive transfer; unknown and system-SSH folder downloads stay hidden.
  supportsFolderDownload = false,
  // Desktop main can stream from the runtime host directly, including host-zipped folders.
  canStreamFromRuntime = false
): boolean {
  // Native save dialogs require desktop; system-SSH folders lack a recursive transfer contract.
  const hasDownloadCapability = node.isDirectory
    ? Boolean(connectionId ? supportsFolderDownload : canStreamFromRuntime)
    : Boolean(connectionId || runtimeDownloadContext)
  return (
    hasDownloadCapability &&
    (globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__ !== true
  )
}

/**
 * Fetch a runtime-hosted file into a temp copy and open it with the local default app. Hidden for
 * files the OS would run (scripts, installers, apps): those can only be downloaded.
 */
export function shouldShowOpenLocallyAction(
  node: TreeNode,
  connectionId: string | null | undefined,
  canStreamFromRuntime: boolean
): boolean {
  return (
    !node.isDirectory &&
    !connectionId &&
    canStreamFromRuntime &&
    canOpenRuntimeDownloadLocally(node.name)
  )
}

export function shouldShowCopyFileAction(
  node: TreeNode,
  connectionId?: string | null,
  selectionSize = 1
): boolean {
  // Clipboard staging supports desktop paths and direct SSH, not paired runtimes.
  if (node.operationOwner?.kind === 'runtime' || node.operationOwner?.kind === 'unresolved') {
    return false
  }
  // Remote directories need recursive materialization; support only a single concrete file reference.
  return (
    (!connectionId || !node.isDirectory) &&
    selectionSize === 1 &&
    (globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__ !== true
  )
}
