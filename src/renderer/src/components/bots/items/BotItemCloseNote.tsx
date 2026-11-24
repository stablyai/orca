import { useTranslate } from '@/i18n/use-translate'
import type { BotItem } from '../../../../../shared/bots/bot-items'

/** A done or canceled item's closing note, above its fields. */
export function BotItemCloseNote({ item }: { item: BotItem }): React.JSX.Element | null {
  const t = useTranslate()
  if (!item.closeNote) {
    return null
  }
  return (
    <p className="rounded-md bg-muted px-2.5 py-2 text-xs text-muted-foreground">
      {item.status === 'canceled'
        ? t('bots.items.view.canceledNote', 'Canceled:')
        : t('bots.items.view.doneNote', 'Done:')}{' '}
      <span className="text-foreground">{item.closeNote}</span>
    </p>
  )
}

/** What the item counts as done, when it says. */
export function BotItemDoneWhen({ item }: { item: BotItem }): React.JSX.Element | null {
  const t = useTranslate()
  if (!item.doneMeans) {
    return null
  }
  return (
    <section>
      <h3 className="mb-1 text-xs text-muted-foreground">
        {t('bots.items.field.doneMeans', 'Done when')}
      </h3>
      <p
        data-bot-item-cut="lines"
        className="text-[13px] leading-[19px] break-words text-foreground"
      >
        {item.doneMeans}
      </p>
    </section>
  )
}
