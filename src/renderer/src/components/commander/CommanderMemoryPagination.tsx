import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'

export function CommanderMemoryPagination({
  previous,
  next,
  pending
}: {
  previous?: () => void
  next?: () => void
  pending: boolean
}): React.JSX.Element | null {
  const t = useTranslate()
  if (!previous && !next) {
    return null
  }
  return (
    <div className="flex flex-wrap gap-2">
      <Button
        type="button"
        variant="outline"
        size="xs"
        disabled={pending || !previous}
        onClick={previous}
      >
        {t('commander.memory.previousPage', 'Previous page')}
      </Button>
      <Button type="button" variant="outline" size="xs" disabled={pending || !next} onClick={next}>
        {t('commander.memory.nextPage', 'Next page')}
      </Button>
    </div>
  )
}
