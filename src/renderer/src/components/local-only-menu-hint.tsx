import React from 'react'
import { useTranslate } from '@/i18n/use-translate'

/** Trailing reason on a menu item disabled because its target lives on another host. */
export function LocalOnlyMenuHint(): React.JSX.Element {
  const t = useTranslate()
  return (
    <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
      {t('auto.components.sidebar.WorktreeOpenInMenu.localOnly', 'Local only')}
    </span>
  )
}
