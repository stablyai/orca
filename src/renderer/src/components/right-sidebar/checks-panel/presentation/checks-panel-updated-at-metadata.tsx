import type React from 'react'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'

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
          time: new Date(updatedAt).toLocaleString(intlLocale)
        }
      )}
    </div>
  )
}
