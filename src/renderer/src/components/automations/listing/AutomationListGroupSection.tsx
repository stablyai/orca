import React from 'react'
import { useTranslate } from '@/i18n/use-translate'
import type { AutomationListGroup, AutomationListGroupId } from './automation-list-groups'
import type { AutomationListViewItem } from './automation-list-view'

const GROUP_LABELS: Record<AutomationListGroupId, { key: string; fallback: string }> = {
  attention: {
    key: 'auto.components.automations.listGroups.attention',
    fallback: 'Needs attention'
  },
  active: { key: 'auto.components.automations.listGroups.active', fallback: 'Active' },
  paused: { key: 'auto.components.automations.listGroups.paused', fallback: 'Paused' }
}

/** One labelled group of rows; the label names the group for screen readers too. */
export function AutomationListGroupSection({
  group,
  isFirst,
  renderItem
}: {
  group: AutomationListGroup
  isFirst: boolean
  renderItem: (item: AutomationListViewItem) => React.ReactNode
}): React.JSX.Element {
  const t = useTranslate()
  const labelId = `automation-list-group-${group.id}`
  const label = GROUP_LABELS[group.id]
  return (
    // Why: rows are buttons, not grid cells, so a labelled group (not rowgroup) carries the context.
    <div
      role="group"
      aria-labelledby={labelId}
      className={isFirst ? undefined : 'border-t border-border/50'}
    >
      <div
        id={labelId}
        className="sticky left-0 w-fit px-3 pb-1 pt-3 text-xs font-semibold text-muted-foreground"
      >
        {t(label.key, label.fallback)}
        <span className="ml-1.5 font-normal tabular-nums">
          <span aria-hidden="true">· </span>
          {group.items.length}
        </span>
      </div>
      <div className="divide-y divide-border/50">{group.items.map(renderItem)}</div>
    </div>
  )
}
