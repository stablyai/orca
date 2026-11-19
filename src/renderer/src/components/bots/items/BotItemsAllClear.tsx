// The Items tab's all-clear line: the bot's own picture, greyed, over "Nothing needs you", at the list's top.
import { useTranslate } from '@/i18n/use-translate'

/** Greys the picture shown above the line; the caller sizes it to 40px. */
export const ALL_CLEAR_PICTURE = 'pointer-events-none opacity-50 grayscale dark:opacity-40'

export function BotItemsAllClear({ picture }: { picture: React.ReactNode }): React.JSX.Element {
  const t = useTranslate()
  return (
    <div role="status" className="flex min-w-0 flex-col items-center gap-2 px-2 py-3">
      {picture}
      <p className="max-w-full truncate whitespace-nowrap text-xs text-muted-foreground">
        {t('bots.items.empty.allClear', 'Nothing needs you')}
      </p>
    </div>
  )
}
