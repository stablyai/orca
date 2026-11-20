import { filesystemPathToFileUri } from '../../../../../../shared/file-links/file-uri-path'
import { isPairedWebClientWindow } from '@/app-shell/chrome/desktop-window-chrome'
import type { TreeNode } from '../tree/file-explorer-types'

// Chromium's DownloadURL lets external apps receive the file while Orca targets keep reading the internal MIME types.
const DOWNLOAD_URL_MIME = 'DownloadURL'

/** The row's operation owner, not the repo's connection, decides whether the file is on this disk. */
export function canDragOutFile(node: TreeNode, dragPathCount: number): boolean {
  return (
    !node.isDirectory &&
    dragPathCount === 1 &&
    node.operationOwner?.kind === 'local' &&
    // DownloadURL splits on ':', so a colon in the name would corrupt the file URL.
    !node.name.includes(':') &&
    !isPairedWebClientWindow()
  )
}

export function writeFileExplorerDragOut(
  dataTransfer: Pick<DataTransfer, 'setData'>,
  node: TreeNode
): void {
  dataTransfer.setData(
    DOWNLOAD_URL_MIME,
    `application/octet-stream:${node.name}:${filesystemPathToFileUri(node.path)}`
  )
}
