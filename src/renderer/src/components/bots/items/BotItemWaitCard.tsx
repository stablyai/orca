// What a Waiting item waits on, in Activity where the move to Waiting is: the Needs you card's calm
// sibling, on the comment card's surface with no tag and nothing to answer. Once the item moves on,
// that move reads as a plain line again.
import { useTranslate } from '@/i18n/use-translate'
import { NativeChatMessageTimestamp } from '../../native-chat/messages/rows/NativeChatMessageTimestamp'
import { BotItemStatusIcon } from './BotItemStatusIcon'

export function BotItemWaitCard({ text, at }: { text: string; at: number }): React.JSX.Element {
  const t = useTranslate()
  const title = t('bots.items.activity.waitingOn', 'Waiting on')
  return (
    // Opaque under the tint so the Activity rail never shows through, bleeding past the column as
    // comment cards do.
    <div className="relative -mx-2 my-1 rounded-[10px] bg-sidebar">
      <div
        role="article"
        aria-label={title}
        className="rounded-[10px] bg-foreground/[0.035] px-2 pt-1.5 pb-2 inset-ring inset-ring-border dark:bg-muted"
      >
        <div className="mb-1 flex min-w-0 items-center gap-x-1.5 text-xs text-muted-foreground">
          <div className="flex min-w-0 flex-auto items-center gap-2">
            <span className="flex size-5 shrink-0 items-center justify-center">
              <BotItemStatusIcon status="waiting" />
            </span>
            <b className="min-w-0 truncate text-[13px] font-medium text-foreground">{title}</b>
          </div>
          <NativeChatMessageTimestamp
            timestamp={at}
            className="ml-auto shrink-0 text-2xs text-muted-foreground"
          />
        </div>
        <p className="min-w-0 pl-7 text-[13px] leading-[19px] text-foreground [overflow-wrap:anywhere]">
          {text}
        </p>
      </div>
    </div>
  )
}
