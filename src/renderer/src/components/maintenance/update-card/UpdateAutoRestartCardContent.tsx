import { Button } from '../../ui/button'
import { uiNumberFormat } from '@/i18n/ui-intl-formatters'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import { useNow } from '@/lib/window-activity/use-now'

const SECOND_UNIT_FORMAT: Intl.NumberFormatOptions = {
  style: 'unit',
  unit: 'second',
  unitDisplay: 'narrow'
}

export function UpdateAutoRestartCardContent({
  version,
  restartAt,
  onRestart,
  onDecline
}: {
  version: string
  restartAt: number
  onRestart: () => void
  onDecline: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const locale = useIntlLocale()
  const now = useNow(1000)
  const seconds = Math.max(0, Math.ceil((restartAt - now) / 1000))
  const time = uiNumberFormat(SECOND_UNIT_FORMAT, locale).format(seconds)
  return (
    <div className="flex flex-col gap-3 p-4">
      <h3 className="text-sm font-semibold">
        {t('updates.autoRestart.countdownTitle', 'Restarting to update')}
      </h3>
      <p className="text-sm text-muted-foreground tabular-nums" aria-live="off">
        {t(
          'updates.autoRestart.countdownBody',
          'Orca restarts in {{time}} to install v{{version}}.',
          {
            time,
            version
          }
        )}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={onRestart}>
          {t('auto.components.UpdateCard.68b235d264', 'Restart to Update')}
        </Button>
        <Button variant="outline" size="sm" onClick={onDecline}>
          {t('updates.autoRestart.notNow', 'Not now')}
        </Button>
      </div>
    </div>
  )
}
