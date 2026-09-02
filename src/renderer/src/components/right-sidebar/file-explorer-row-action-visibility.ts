import type { RuntimeFileOperationArgs } from '@/runtime/runtime-file-client'
import type { TreeNode } from './file-explorer-types'

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
  // Why: fail closed — only show folder download when the connection explicitly
  // advertises SFTP recursive transfer (system-SSH and unknown states stay off).
  supportsFolderDownload = false
): boolean {
  // Why: Desktop-only because download depends on Electron's native save/folder dialogs;
  // runtime and system-SSH folders have no recursive transfer contract.
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
  // Why: remote directories would require recursive materialization semantics;
  // keep this to a single concrete file reference until multi-file copy exists.
  return (
    (!connectionId || !node.isDirectory) &&
    selectionSize === 1 &&
    (globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__ !== true
  )
}
