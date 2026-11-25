import { useContext } from 'react'
import { ArrowRightLeft } from 'lucide-react'
import type { TookOverNotice } from '../../../../shared/native-chat/took-over-notice'
import { useTranslation } from 'react-i18next'
import { useBotForWorkspace } from '@/components/bots/bot-workspace'
import { useTranslate } from '@/i18n/use-translate'
import { NativeChatDividerRow } from './NativeChatDividerRow'
import { NativeChatBotKickoffContext } from './native-chat-bot-kickoff-view'
import { NativeChatMessageTimestamp } from './messages/rows/NativeChatMessageTimestamp'
import { useNativeChatVisualOwner } from './media/visuals/native-chat-visual-owner'

/** The first setup turn shows when the chat started. Subsequent setup turns remain notices. */
export function NativeChatBotCreatedRow({
  messageId,
  timestamp
}: {
  messageId: string
  timestamp: number | null
}): React.JSX.Element {
  const t = useTranslate()
  useTranslation()
  const bot = useBotForWorkspace(useNativeChatVisualOwner()?.worktreeId ?? null)
  const firstKickoffId = useContext(NativeChatBotKickoffContext)?.firstKickoffId
  if (bot && (firstKickoffId ?? messageId) === messageId) {
    return <NativeChatMessageTimestamp timestamp={timestamp} className="mx-auto block w-fit pb-3" />
  }
  const label = bot
    ? t('components.native-chat.botCreated.again', '{{name}} started setting up again', {
        name: bot.name
      })
    : t('components.native-chat.botCreated.unnamed', 'Bot created')
  return (
    <NativeChatDividerRow label={label}>
      {label}
      {timestamp !== null ? <span aria-hidden>·</span> : null}
      <NativeChatMessageTimestamp timestamp={timestamp} />
    </NativeChatDividerRow>
  )
}

/** A workspace takeover precedes the owner’s first goal in the transcript. */
export function NativeChatTookOverRow({
  tookOver,
  timestamp
}: {
  tookOver: TookOverNotice | undefined
  timestamp: number | null
}): React.JSX.Element | null {
  const t = useTranslate()
  useTranslation()
  if (!tookOver) {
    return null
  }
  const label = t('components.native-chat.tookOver', 'Took over {{workspace}}', {
    workspace: tookOver.workspace
  })
  return (
    <NativeChatDividerRow label={label}>
      <ArrowRightLeft className="size-3" aria-hidden />
      {label}
      {timestamp !== null ? <span aria-hidden>·</span> : null}
      <NativeChatMessageTimestamp timestamp={timestamp} />
    </NativeChatDividerRow>
  )
}
