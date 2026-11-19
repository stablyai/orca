// How an agent's question looks on its item page, in one place so the look can change without touching
// behavior: the open ask's amber rim, tint and lift with its "Waiting on you" flag (amber means exactly
// that, nowhere else), the answered ask's quiet card, and the question's words clamped with Show more.
import { useTranslate } from '@/i18n/use-translate'
import { NativeChatQuestionText } from '../../native-chat/prompts/NativeChatQuestionText'
import { BotItemClampedText } from './BotItemClampedText'

/** The open ask's card body: outer ring, amber-edged border, tinted surface and lift. */
export const BOT_ITEM_OPEN_ASK_SURFACE =
  'border-[color-mix(in_srgb,var(--item-ask-open)_45%,var(--question-card-border))] bg-[color-mix(in_srgb,var(--item-ask-open)_6%,var(--chat-composer-surface))] shadow-[0_0_0_2px_color-mix(in_srgb,var(--item-ask-open)_55%,transparent),0_4px_14px_rgb(0_0_0/0.12)]'

/** A closed ask's card: the plain question card, dimmed to read as history. */
export const BOT_ITEM_CLOSED_ASK_SURFACE =
  'rounded-[14px] border border-question-card-border bg-chat-composer-surface shadow-[0_1px_2px_rgb(0_0_0/0.04)] opacity-72'

/** "WAITING ON YOU" with its amber dot, always shown above an open ask's question. */
export function BotItemWaitingFlag(): React.JSX.Element {
  const t = useTranslate()
  return (
    <span
      data-bot-item-waiting-flag
      className="flex items-center gap-1.5 text-[10.5px] font-bold uppercase tracking-wide text-item-ask-open-text"
    >
      <span aria-hidden className="size-1.5 rounded-full bg-item-ask-open" />
      {t('bots.items.activity.waitingOnYou', 'Waiting on you')}
    </span>
  )
}

/** A question's words as chat's question card draws them, cut at six lines with Show more. */
export function BotItemQuestionHeading({
  text,
  muted = false
}: {
  text: string
  muted?: boolean
}): React.JSX.Element {
  return (
    <BotItemClampedText
      text={text}
      // Whole lines with an ellipsis where the cut falls, so a cut link or word reads as cut; a long
      // link may break anywhere, so its own last line carries that ellipsis.
      clampClassName="line-clamp-6 [&_a]:[overflow-wrap:anywhere]"
      render={(shown) => (
        <NativeChatQuestionText
          content={shown}
          className={
            muted
              ? 'break-words text-sm font-medium text-muted-foreground [&_p]:my-0 [&_p+p]:mt-2'
              : 'break-words text-sm font-medium text-foreground [&_p]:my-0 [&_p+p]:mt-2'
          }
        />
      )}
    />
  )
}
