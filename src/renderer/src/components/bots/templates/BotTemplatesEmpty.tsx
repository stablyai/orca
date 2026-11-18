import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'

/** A search no template matches: a blank bot for it, or back to every template. */
export function BotTemplatesEmpty({
  query,
  onBlank,
  onClear
}: {
  query: string
  onBlank: () => void
  onClear: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const trimmed = query.trim()
  return (
    <div className="flex flex-col items-center gap-3 px-6 pt-[12vh] text-center">
      <p className="text-sm font-medium text-foreground">
        {t('bots.templates.noMatch', 'No templates match “{{query}}”', { query: trimmed })}
      </p>
      <p className="text-xs text-muted-foreground">
        {t(
          'bots.templates.noMatchLine',
          'Start a blank bot and tell it what it’s for in its first chat.'
        )}
      </p>
      <div className="flex gap-2">
        <Button size="sm" variant="outline" onClick={onBlank}>
          {t('bots.templates.blankFor', 'Blank bot for “{{query}}”', { query: trimmed })}
        </Button>
        <Button size="sm" variant="ghost" onClick={onClear}>
          {t('bots.templates.clearSearch', 'Clear search')}
        </Button>
      </div>
    </div>
  )
}
