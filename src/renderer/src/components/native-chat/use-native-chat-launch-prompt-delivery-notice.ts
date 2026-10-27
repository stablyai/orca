import { useMemo } from 'react'
import { translate } from '@/i18n/i18n'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import type { NativeChatDeliveryNotice } from './NativeChatMessageRow'

/** Show refused launch prompts only while their row is visible; recovery belongs in the terminal, so offer no Retry. */
export function useNativeChatLaunchPromptDeliveryNotice(
  failedMessageId: string | null | undefined,
  messages: readonly NativeChatMessage[]
): ReadonlyMap<string, NativeChatDeliveryNotice> | undefined {
  return useMemo(() => {
    if (!failedMessageId || !messages.some((message) => message.id === failedMessageId)) {
      return undefined
    }
    const text = translate(
      'components.native-chat.launchPromptNotDelivered',
      'Not delivered — check the terminal'
    )
    return new Map([[failedMessageId, { text }]])
  }, [failedMessageId, messages])
}
