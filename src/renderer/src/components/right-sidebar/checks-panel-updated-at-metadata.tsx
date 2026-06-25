import type React from 'react'
import { translate } from '@/i18n/i18n'

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
      {reviewShortLabel}{' '}
      {translate('auto.components.right.sidebar.ChecksPanel.34464d00b9', 'updated')}{' '}
      {new Date(updatedAt).toLocaleString()}
    </div>
  )
}
