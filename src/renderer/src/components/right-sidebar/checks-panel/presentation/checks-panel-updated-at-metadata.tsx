import type React from 'react'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import { uiDateTimeFormat } from '@/i18n/ui-intl-formatters'
import { DATE_TIME_NUMERIC } from '../../../../../../shared/i18n/regional-date-time-format'

type ChecksPanelUpdatedAtMetadataProps = {
  reviewShortLabel: string
  updatedAt: string
}

export function ChecksPanelUpdatedAtMetadata({
  reviewShortLabel,
  updatedAt
}: ChecksPanelUpdatedAtMetadataProps): React.JSX.Element {
  const t = useTranslate()
  const intlLocale = useIntlLocale()
  return (
    <div className="text-[10px] text-muted-foreground/60">
      {t(
        'auto.components.right.sidebar.ChecksPanel.reviewUpdatedAt',
        '{{review}} updated {{time}}',
        {
          review: reviewShortLabel,
          time: uiDateTimeFormat(DATE_TIME_NUMERIC, intlLocale).format(new Date(updatedAt))
        }
      )}
    </div>
  )
}
