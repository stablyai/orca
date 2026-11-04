import type React from 'react'
import { getIntlLocale, translate } from '@/i18n/i18n'

type ChecksPanelUpdatedAtMetadataProps = {
  reviewShortLabel: string
  updatedAt: string
}

export function ChecksPanelUpdatedAtMetadata({
  reviewShortLabel,
  updatedAt
}: ChecksPanelUpdatedAtMetadataProps): React.JSX.Element {
  return (
    <div className="text-[10px] text-muted-foreground/60">
      {translate(
        'auto.components.right.sidebar.ChecksPanel.reviewUpdatedAt',
        '{{review}} updated {{time}}',
        {
          review: reviewShortLabel,
          time: new Date(updatedAt).toLocaleString(getIntlLocale())
        }
      )}
    </div>
  )
}
