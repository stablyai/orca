import { translate } from '@/i18n/i18n'
import type { ConfirmationDialogContextValue } from '@/components/confirmation-dialog-context'
import type {
  AgentSessionRewindMode,
  RewindFilesPreview
} from '../../../../shared/agent-session-rewind-files'

export async function confirmNativeChatRewind(
  input: {
    itemId: string
    expectedEpoch: string
    previewFiles?: (fields: {
      itemId: string
      expectedEpoch: string
    }) => Promise<RewindFilesPreview>
    isCurrent: () => boolean
  },
  confirm: ConfirmationDialogContextValue
) {
  const { itemId, expectedEpoch } = input
  const preview = input.previewFiles
    ? await input.previewFiles({ itemId, expectedEpoch }).catch((): RewindFilesPreview => ({
        available: false,
        reason: 'This host cannot preview file recovery.'
      }))
    : undefined
  if (!input.isCurrent()) {
    return
  }
  const choice: { mode: AgentSessionRewindMode } = { mode: 'conversation' }
  const confirmed = await confirm({
    title: translate('components.native-chat.rewind.title', 'Rewind to here?'),
    description: preview
      ? translate(
          'components.native-chat.rewind.confirmationScope',
          'Discard this message and everything after it? The message returns to the composer so you can edit and resend it.'
        )
      : translate(
          'components.native-chat.rewind.confirmation',
          'Discard this message and everything after it? The message returns to the composer so you can edit and resend it. File changes on disk are kept.'
        ),
    ...(preview
      ? {
          choices: {
            label: translate('components.native-chat.rewind.scope', 'What to rewind'),
            defaultValue: 'conversation',
            items: [
              {
                value: 'conversation',
                label: translate(
                  'components.native-chat.rewind.conversationOnly',
                  'Conversation only'
                ),
                description: translate(
                  'components.native-chat.rewind.keepFiles',
                  'Keep file changes on disk.'
                )
              },
              {
                value: 'conversation-and-files',
                label: translate(
                  'components.native-chat.rewind.withFiles',
                  'Conversation and recorded file changes'
                ),
                disabled: !preview.available,
                description: preview.available ? preview.files.join('\n') : preview.reason
              }
            ],
            onConfirmed: (value: string) => {
              choice.mode =
                value === 'conversation-and-files' && preview?.available
                  ? 'conversation-and-files'
                  : 'conversation'
            }
          }
        }
      : {}),
    confirmLabel: translate('components.native-chat.rewind.confirm', 'Rewind'),
    cancelLabel: translate('components.native-chat.rewind.cancel', 'Cancel'),
    confirmVariant: 'destructive',
    cancelVariant: 'ghost'
  })

  return {
    confirmed,
    mode: choice.mode,
    ...(choice.mode === 'conversation-and-files' && preview?.available
      ? { filesFingerprint: preview.fingerprint }
      : {})
  }
}
