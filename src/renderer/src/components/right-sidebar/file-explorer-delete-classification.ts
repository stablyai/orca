import { translate } from '@/i18n/i18n'
import {
  getFileExplorerOperationRoute,
  getFileExplorerOwnerUnresolvedMessage
} from './file-explorer-operation-owner'
import type { TreeNode } from './file-explorer-types'

export function needsRemoteDeleteConfirmation(node: TreeNode): boolean {
  const owner = node.operationOwner ?? { kind: 'unresolved' as const }
  return owner.kind !== 'local' && getFileExplorerOperationRoute(owner) !== null
}

export function isLocalDeleteNode(node: TreeNode): boolean {
  return (node.operationOwner ?? { kind: 'unresolved' as const }).kind === 'local'
}

export function getFileDeleteErrorMessage(error: unknown): string | null {
  if (!(error instanceof Error)) {
    return null
  }
  return error.message === getFileExplorerOwnerUnresolvedMessage()
    ? translate(
        'auto.components.right.sidebar.useFileDeletion.8b8ee9d22f',
        "Couldn't determine which host owns this file. Check the workspace connection and try again."
      )
    : error.message
}
