import type { ConfirmationDialogContextValue } from '@/components/confirmation-dialog-context'
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

// Remote deletes bypass Trash and may be unrecoverable.
export function confirmRemoteDelete(
  confirm: ConfirmationDialogContextValue,
  node: TreeNode
): Promise<boolean> {
  return confirm({
    title: translate(
      'auto.components.right.sidebar.useFileDeletion.d979a4fbb5',
      "Permanently delete '{{value0}}'?",
      { value0: node.name }
    ),
    description: node.isDirectory
      ? translate(
          'auto.components.right.sidebar.useFileDeletion.7fb9435c86',
          'This permanently deletes the directory and its contents on the remote host. This cannot be undone.'
        )
      : translate(
          'auto.components.right.sidebar.useFileDeletion.23e98f192f',
          'This permanently deletes the file on the remote host. This cannot be undone.'
        ),
    confirmLabel: translate('auto.components.right.sidebar.useFileDeletion.92276aceb7', 'Delete'),
    confirmVariant: 'destructive'
  })
}
