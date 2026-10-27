import React from 'react'
import { translate } from '@/i18n/i18n'

/** Trailing reason on a menu item disabled because its target lives on another host. */
export function LocalOnlyMenuHint(): React.JSX.Element {
  return (
    <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
      {translate('auto.components.sidebar.WorktreeOpenInMenu.localOnly', 'Local only')}
    </span>
  )
}
