import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import { uiDateTimeFormat } from '@/i18n/ui-intl-formatters'
import type { CommanderMemorySummary } from '../../../../shared/commander/memory-contract'
import { memoryActor } from './commander-memory-labels'

const brief: Intl.DateTimeFormatOptions = { dateStyle: 'short', timeStyle: 'short' }
const full: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'medium' }

export function CommanderHandoffMetadata({
  page,
  showActor = false
}: {
  page: CommanderMemorySummary
  showActor?: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const locale = useIntlLocale()
  const timestamp = Date.parse(page.createdAt)
  return (
    <span className="block break-words text-xs text-muted-foreground">
      {page.projectId ?? t('commander.memory.global', 'Account-wide')} ·{' '}
      {t('commander.memory.version', 'v{{version}}', { version: page.version })}
      {showActor && (
        <>
          {' '}
          · {memoryActor(t, page.actor.type)} · {page.actor.id}
        </>
      )}
      {Number.isFinite(timestamp) && (
        <>
          {' '}
          ·{' '}
          <time dateTime={page.createdAt}>
            {uiDateTimeFormat(showActor ? full : brief, locale).format(timestamp)}
          </time>
        </>
      )}
    </span>
  )
}
