import type React from 'react'
import { translate } from '@/i18n/i18n'
import type { GroupHeaderRow } from '../../../../../../shared/sidebar-list/row-types'

/** Heads the Active / Idle part of the project list; its h-5 is RUNNING_SECTION_LABEL_HEIGHT. */
export function RunningSectionLabel({
  label
}: {
  label: NonNullable<GroupHeaderRow['runningSectionLabel']>
}): React.JSX.Element {
  return (
    <div
      className="flex h-5 items-center px-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"
      data-running-section-label={label}
    >
      {label === 'active'
        ? translate('auto.components.sidebar.SidebarHeader.activeProjects', 'Active')
        : translate('auto.components.sidebar.SidebarHeader.idleProjects', 'Idle')}
    </div>
  )
}
