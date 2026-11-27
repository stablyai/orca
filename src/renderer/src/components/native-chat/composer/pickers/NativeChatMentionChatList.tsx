// A bot's chats inside the `@` list (or a pill's list): "‹ Bot" on top, then its chats as its
// Activity panel rows show them, or why there are none.
import { Check, ChevronLeft, RotateCcw } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { botMentionChatsMatching } from '../../../../../../shared/bots/bot-mention-context'
import type {
  NativeChatBotChatPicker,
  NativeChatMentionChat
} from '../../native-chat-mention-chats'
import { PickerOptionButton, PickerStatus } from './NativeChatPickerParts'

/** The chats `filter` leaves, in the order the list shows them. */
export function nativeChatMentionChatOptions(
  shown: NonNullable<NativeChatBotChatPicker['shown']>,
  filter: string
): readonly NativeChatMentionChat[] {
  return shown.chats.status === 'ready' ? botMentionChatsMatching(shown.chats.chats, filter) : []
}

export function NativeChatMentionChatList({
  shown,
  filter,
  activeIndex,
  listboxId,
  checkedId,
  activeItemRef,
  onPick,
  onBack,
  onRetry
}: {
  shown: NonNullable<NativeChatBotChatPicker['shown']>
  filter: string
  activeIndex: number
  listboxId: string
  /** The chat a pill already names (its Home Chat for a plain pill), marked in its list. */
  checkedId?: string | null
  activeItemRef: React.MutableRefObject<HTMLButtonElement | null>
  onPick: (chat: NativeChatMentionChat) => void
  /** Back to the bots; absent in a pill's list, which has nowhere to go back to. */
  onBack?: () => void
  onRetry: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const { chats } = shown
  const options = nativeChatMentionChatOptions(shown, filter)
  const others = chats.status === 'ready' ? chats.chats.filter((chat) => !chat.plain) : []
  const noOthers =
    chats.status === 'ready' && filter.trim() === '' && others.length === 0
      ? t('components.native-chat.composer.noOtherChats', 'No other chats')
      : null
  const noMatches =
    chats.status === 'ready' && filter.trim() !== '' && options.length === 0
      ? t('components.native-chat.composer.noMatchingChats', 'No matching chats')
      : null
  const header = (
    <span className="flex min-w-0 items-center gap-1.5">
      {onBack ? (
        <ChevronLeft aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      ) : null}
      <span aria-hidden className="flex size-4 shrink-0">
        {shown.avatar}
      </span>
      <span className="min-w-0 truncate font-medium">{shown.name}</span>
    </span>
  )
  const announced =
    chats.status === 'loading'
      ? t('components.native-chat.composer.loadingBotChats', "Loading {{name}}'s chats…", {
          name: shown.name
        })
      : chats.status === 'error'
        ? chats.message
        : (noMatches ??
          t('components.native-chat.composer.botChatsCount', "{{name}}'s chats, {{chatCount}}", {
            name: shown.name,
            chatCount: options.length
          }))
  return (
    <>
      <div className="sticky -top-1 z-10 -mx-1 -mt-1 bg-inherit px-1 pt-1">
        {onBack ? (
          <button
            type="button"
            tabIndex={-1}
            onPointerDown={(event) => event.preventDefault()}
            onClick={onBack}
            aria-label={t('components.native-chat.composer.backToBots', 'Back to bots')}
            className="flex w-full items-center rounded-md px-1.5 py-1 text-left text-xs hover:bg-accent hover:text-accent-foreground"
          >
            {header}
          </button>
        ) : (
          <div className="px-1.5 py-1 text-xs">{header}</div>
        )}
      </div>
      {chats.status === 'loading' ? (
        // The height of a row, so the list doesn't jump when the chats arrive.
        <PickerStatus busy className="min-h-12">
          {announced}
        </PickerStatus>
      ) : null}
      {chats.status === 'error' ? (
        <PickerStatus>
          <span className="min-w-0 flex-1">{chats.message}</span>
          <button
            type="button"
            onPointerDown={(event) => event.preventDefault()}
            onClick={onRetry}
            className="flex shrink-0 items-center gap-1 rounded-sm px-1.5 py-0.5 text-foreground hover:bg-accent hover:text-accent-foreground"
          >
            <RotateCcw className="size-3" />
            {t('components.native-chat.composer.retryChats', 'Retry')}
          </button>
        </PickerStatus>
      ) : null}
      {options.map((chat, index) => (
        <PickerOptionButton
          key={chat.id}
          id={`${listboxId}-option-${index}`}
          selected={index === activeIndex}
          activeItemRef={activeItemRef}
          onChoose={() => onPick(chat)}
          title={chat.title}
        >
          <span aria-hidden className="flex h-5 w-4 shrink-0 items-center justify-center">
            {chat.icon}
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-baseline gap-2">
              <span className="min-w-0 flex-1 truncate">{chat.title}</span>
              {chat.time ? (
                <span className="shrink-0 text-2xs text-muted-foreground">{chat.time}</span>
              ) : null}
            </span>
            <span className="block truncate text-xs text-muted-foreground">{chat.line}</span>
          </span>
          <Check
            aria-hidden
            className={cn('mt-0.5 size-3.5 shrink-0', checkedId === chat.id ? '' : 'hidden')}
          />
        </PickerOptionButton>
      ))}
      {noOthers || noMatches ? <PickerStatus>{noOthers ?? noMatches}</PickerStatus> : null}
      <div aria-live="polite" className="sr-only">
        {announced}
      </div>
    </>
  )
}
