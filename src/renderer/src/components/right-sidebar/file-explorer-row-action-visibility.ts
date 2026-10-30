import type { RuntimeFileOperationArgs } from '@/runtime/runtime-file-client-types'
import type { TreeNode } from './file-explorer-types'
import { getRelativePathInsideRoot } from '@/lib/path'

export function isFileExplorerPathReadOnly(
  filePath: string,
  worktreePath: string | null,
  outsideWorkspaceRoot: boolean
): boolean {
  return outsideWorkspaceRoot && getRelativePathInsideRoot(filePath, worktreePath) === null
}

export function isFileExplorerNodeReadOnly(
  node: TreeNode,
  worktreePath: string | null,
  outsideWorkspaceRoot: boolean
): boolean {
  return isFileExplorerPathReadOnly(node.path, worktreePath, outsideWorkspaceRoot)
}

export function shouldShowCollapseFolderAction(node: TreeNode, isExpanded: boolean): boolean {
  return node.isDirectory && isExpanded
}

export function shouldShowCopyRelativePathAction(_node: TreeNode, readOnly = false): boolean {
  return !readOnly
}

export function shouldShowFindInFolderAction(node: TreeNode, readOnly = false): boolean {
  return node.isDirectory && !readOnly
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
  supportsFolderDownload = false
): boolean {
  // Native save dialogs require desktop; runtime/system-SSH folders lack recursive transfer contracts.
  const hasDownloadCapability = node.isDirectory
    ? Boolean(connectionId && supportsFolderDownload)
    : Boolean(connectionId || runtimeDownloadContext)
  return (
    hasDownloadCapability &&
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
