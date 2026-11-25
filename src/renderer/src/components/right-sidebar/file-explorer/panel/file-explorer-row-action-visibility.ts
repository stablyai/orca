import type { RuntimeFileOperationArgs } from '@/runtime/files/runtime-file-client-types'
import type { TreeNode } from '../tree/file-explorer-types'

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
  runtimeDownloadContext?: RuntimeFileOperationArgs | null
): boolean {
  // Native save dialogs require desktop; no host serves a recursive folder transfer.
  return (
    !node.isDirectory &&
    Boolean(connectionId || runtimeDownloadContext) &&
    (globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__ !== true
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
