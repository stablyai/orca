import { useContext, useState } from 'react'
import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react'
import { Bot, BotOff } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { botMentionTokens } from '../../../../../../shared/bots/bot-mention-context'
import {
  NativeChatBotChatChooserContext,
  NativeChatBotChatPickerContext,
  NativeChatBotMentionTargetContext
} from '../../native-chat-room-context'
import type { NativeChatMentionChat } from '../../native-chat-mention-chats'
import { NativeChatPromptPill } from './NativeChatPromptPill'
import { botChatIdLabel } from '../../native-chat-markdown-mentions'
import { NativeChatBotChatChooser } from './NativeChatBotChatChooser'
import { BOT_MENTION_NODE } from './native-chat-prompt-document-text'

/** A bot picked under `@`, or one of its chats: its picture and current name, then `›` and the
 *  chat's current title. A bot since deleted or paused, or a chat that can't take the message, shows
 *  dimmed, since the message won't reach it; until the chat's computer has listed its bots, the pill
 *  shows the name it was picked with. Its ⌄ changes or clears the chat. */
export function NativeChatBotMentionPill({
  node,
  selected,
  editor,
  getPos,
  updateAttributes
}: NodeViewProps): React.JSX.Element {
  const t = useTranslate()
  const id = String(node.attrs.id)
  const chatId = String(node.attrs.chatId ?? '')
  const server = String(node.attrs.server ?? '') || undefined
  const target = useContext(NativeChatBotMentionTargetContext)(id, server)
  const picker = useContext(NativeChatBotChatPickerContext)
  const chooser = useContext(NativeChatBotChatChooserContext)
  const [hovered, setHovered] = useState(false)
  // Bound by id, so a renamed bot shows its new name; the picked one stands in until it is read.
  const name = target?.name ?? String(node.attrs.name)
  const state = target === null ? 'missing' : target?.paused ? 'paused' : undefined
  const pick = chatId && target ? (picker?.pick(id, chatId) ?? { state: 'checking' }) : null
  const chatGone = pick?.state === 'unavailable'
  const unavailable = t('bots.chat.mentionChatUnavailable', 'Chat unavailable')
  const why =
    state === 'missing'
      ? t('bots.chat.mentionMissing', "This bot no longer exists; this message won't reach it")
      : state === 'paused'
        ? t('bots.chat.mentionPaused', 'Paused')
        : chatGone && typeof pick.why === 'string'
          ? pick.why
          : undefined
  // The name stays in both: a long one is truncated on the pill.
  const title = why ? t('bots.chat.mentionStateTitle', '{{name}}: {{why}}', { name, why }) : name
  const spokenLabel =
    state === 'missing'
      ? t('bots.chat.mentionLabelMissing', 'Mentioned bot: {{name}}, no longer exists', { name })
      : state === 'paused'
        ? t('bots.chat.mentionLabelPaused', 'Mentioned bot: {{name}}, paused', { name })
        : chatId && chatGone
          ? t(
              'bots.chat.mentionLabelChatUnavailable',
              'Mentioned bot: {{name}}, chat unavailable',
              {
                name
              }
            )
          : t('bots.chat.mentionLabel', 'Mentioned bot: {{name}}', { name })
  const detail = chatId ? (chatGone ? unavailable : picker?.title(id, chatId)) : undefined
  // A chat pill says which chat, as it shows it, so two of one bot's chats read apart.
  const spoken =
    chatId && !chatGone && state === undefined ? (
      <>
        {t('bots.chat.mentionLabelChat', 'Mentioned bot: {{name}}, chat', { name })}{' '}
        {detail ?? botChatIdLabel(chatId)}
      </>
    ) : (
      spokenLabel
    )
  const pill = (trailing?: React.ReactNode) => (
    <NativeChatPromptPill
      icon={state === 'missing' ? BotOff : Bot}
      avatar={target?.avatar}
      label={name}
      spokenLabel={spoken}
      muted={state !== undefined || chatGone}
      title={title}
      selected={selected}
      detail={detail}
      trailing={trailing}
    />
  )
  // A chat pill always offers its list; the bot alone only while hovered or selected.
  const offers = picker !== undefined && state === undefined && !server && picker.offers(id)
  // Its place among the draft's bot pills, as the composer counts its tokens.
  const at = (): number | null => {
    const pos = getPos()
    if (typeof pos !== 'number') {
      return null
    }
    let index = 0
    editor.state.doc.nodesBetween(0, pos, (child) => {
      if (child.type.name === BOT_MENTION_NODE) {
        index += 1
      }
    })
    return index
  }
  const open = chooser !== null && chooser.at !== null && chooser.at === at()
  const showChooser = offers && (chatId !== '' || hovered || selected || open)
  const close = (): void => {
    chooser?.close()
    // The caret goes back to just after the pill.
    const pos = getPos()
    if (typeof pos === 'number') {
      editor
        .chain()
        .focus()
        .setTextSelection(pos + node.nodeSize)
        .run()
    }
  }
  const choose = (chat: NativeChatMentionChat): void => {
    if (picker) {
      const [picked] = botMentionTokens(picker.token(id, chat))
      updateAttributes({ chatId: picked?.chatId ?? '' })
    }
    close()
  }
  return (
    <NodeViewWrapper
      as="span"
      className="inline"
      contentEditable={false}
      data-native-chat-bot-mention={id}
      data-native-chat-bot-chat={chatId || undefined}
      data-bot-state={state ?? (chatGone ? 'chat-unavailable' : undefined)}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
    >
      {showChooser && picker ? (
        <NativeChatBotChatChooser
          picker={picker}
          botId={id}
          chatId={chatId}
          open={open}
          onOpenChange={(next) => {
            const start = at()
            if (next && start !== null) {
              chooser?.open(start)
            } else if (!next) {
              close()
            }
          }}
          onPick={choose}
          label={
            chatId
              ? t('components.native-chat.composer.changeChat', 'Change chat')
              : t('components.native-chat.composer.chooseChat', 'Choose chat')
          }
        >
          {pill}
        </NativeChatBotChatChooser>
      ) : (
        pill()
      )}
    </NodeViewWrapper>
  )
}
