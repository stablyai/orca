import { filesystemPathToFileUri } from '../../../../../../shared/file-links/file-uri-path'
import type { RuntimeFileOperationArgs } from '@/runtime/files/runtime-file-client-types'
import { isPairedWebClientWindow } from '@/app-shell/chrome/desktop-window-chrome'
import type { TreeNode } from '../tree/file-explorer-types'

// Chromium's DownloadURL lets external apps receive the file while Orca targets keep reading the internal MIME types.
const DOWNLOAD_URL_MIME = 'DownloadURL'

type DragOutContext = {
  connectionId?: string | null
  runtimeDownloadContext?: RuntimeFileOperationArgs | null
}

export function canDragOutFile(
  node: TreeNode,
  dragPathCount: number,
  { connectionId, runtimeDownloadContext }: DragOutContext
): boolean {
  const ownerKind = node.operationOwner?.kind
  return (
    !node.isDirectory &&
    dragPathCount === 1 &&
    !connectionId &&
    !runtimeDownloadContext &&
    (ownerKind === undefined || ownerKind === 'local') &&
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
