import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { ConfirmationDialogContextValue } from '@/components/dismiss/confirmation/confirmation-dialog-context'
import {
  changedFilesList,
  checkedDetail,
  previewNativeChatRewindFiles,
  restoreNativeChatRewindFiles,
  type NativeChatCheckpointClient
} from './native-chat-rewind-files'

/** "Restore files to here": puts the files back to how they were when this message was sent and
 *  leaves the conversation as it is (Claude Code's code-only rewind). Undo is offered after. */
export async function restoreNativeChatFilesOnly(
  client: NativeChatCheckpointClient,
  itemId: string,
  confirm: ConfirmationDialogContextValue
): Promise<void> {
  const preview = await previewNativeChatRewindFiles(client, itemId)
  if (!preview?.available) {
    toast.message(
      translate(
        'components.native-chat.rewind.filesOnlyUnavailable',
        "Orca doesn't have the files saved for this message, so there is nothing to restore."
      )
    )
    return
  }
  if (preview.changedFiles === 0) {
    toast.message(
      translate(
        'components.native-chat.rewind.filesAlreadyMatch',
        'Files on disk already match this message.'
      )
    )
    return
  }
  if (preview.busy) {
    toast.message(
      translate(
        'components.native-chat.rewind.restoreFilesBusy',
        "Files can't be restored while the agent is working."
      )
    )
    return
  }
  const confirmed = await confirm({
    title: translate('components.native-chat.rewind.filesOnlyTitle', 'Restore files to here?'),
    description: `${translate(
      'components.native-chat.rewind.filesOnlyDescription',
      'The chat stays as it is.'
    )} ${checkedDetail(preview.headMoved)}`,
    ...changedFilesList(preview),
    confirmLabel: translate('components.native-chat.rewind.filesOnlyConfirm', 'Restore files'),
    cancelLabel: translate('components.native-chat.rewind.cancel', 'Cancel'),
    confirmVariant: 'destructive',
    initialFocus: 'cancel'
  })
  if (confirmed) {
    await restoreNativeChatRewindFiles(client, itemId, false)
  }
}
