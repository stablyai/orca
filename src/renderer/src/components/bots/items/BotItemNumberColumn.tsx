import { formatBotItemNumber } from '../../../../../shared/bots/bot-items'

/** An item's muted `#35` before a row's title, as wide as the Items list's widest number (`--bot-item-number-chars`). */
export function BotItemNumberColumn({ number }: { number: number }): React.JSX.Element {
  return (
    <span className="min-w-[calc(var(--bot-item-number-chars,3)*1ch+0.375rem)] shrink-0 pr-1.5 text-[13px] leading-5 tabular-nums text-muted-foreground">
      {formatBotItemNumber(number)}
    </span>
  )
}
