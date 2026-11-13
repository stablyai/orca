import { useMemo } from 'react'
import { returnMessageToComposer } from '../../structured/delivery/structured-agent-session-message-hand-back'
import { useTranslate } from '@/i18n/use-translate'
import { useUiLanguageRevision } from '@/i18n/use-ui-language-revision'
import type { NativeChatComposerHandle } from '../../../composer/native-chat-composer-types'
import type { NativeChatPendingSend } from '../../../../../../../shared/native-chat/transcript/native-chat-pending-sends'
import type { NativeChatDeliveryNotice } from '../../../messages/rows/NativeChatMessageRow'

const NO_NOTICES: ReadonlyMap<string, NativeChatDeliveryNotice> = new Map()

export function useNativeChatPendingNotices({
  pending,
  cancel,
  paneKey,
  composerRef
}: {
  pending: NativeChatPendingSend[]
  cancel: (id: string, discard?: boolean) => void
  paneKey: string
  composerRef?: { current: NativeChatComposerHandle | null }
}) {
  const t = useTranslate()
  const languageRevision = useUiLanguageRevision()
  const notices = useMemo(() => {
    if (!pending.some((entry) => entry.delivery === 'rejected')) {
      return NO_NOTICES
    }
    const result = new Map<string, NativeChatDeliveryNotice>()
    for (const entry of pending) {
      if (entry.delivery !== 'rejected') {
        continue
      }
      result.set(`pending:${entry.id}`, {
        text: t('components.native-chat.messageNotSent', 'Message not sent'),
        ...(composerRef
          ? {
              onSend: () => {
                if (composerRef.current?.resend?.(entry.text, entry.imagePaths)) {
                  cancel(entry.id, true)
                }
              }
            }
          : {}),
        onEdit: () => {
          if (
            returnMessageToComposer(paneKey, `pending-${entry.id}`, [
              { type: 'text', text: entry.text },
              ...(entry.imagePaths ?? []).map((path) => ({ type: 'image-ref' as const, path }))
            ])
          ) {
            cancel(entry.id, true)
          }
        },
        onDismiss: () => cancel(entry.id, true)
      })
    }
    return result
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- translate() reads the UI language implicitly.
  }, [pending, cancel, paneKey, composerRef, languageRevision, t])
  return notices
}
