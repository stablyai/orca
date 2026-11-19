import React from 'react'
import { SectionCollapseAllButton } from '@/components/sidebar/worktree-list/controls/SectionCollapseAllButton'
import { useTranslate } from '@/i18n/use-translate'
import type { BotCollapseAll } from './use-bot-collapse-all'

const TOGGLE_ATTRIBUTES = { 'data-bots-collapse-toggle': '' } as const

/** Collapse all bots, after the Bots header's count, as Projects has after its title. */
export function BotsCollapseAllButton({
  collapseAll
}: {
  collapseAll: BotCollapseAll
}): React.JSX.Element {
  const t = useTranslate()
  return (
    // Above the header's fold button, so it takes its own clicks.
    <span className="relative flex">
      <SectionCollapseAllButton
        allCollapsed={collapseAll.allCollapsed}
        onToggle={collapseAll.toggle}
        collapseLabel={t('bots.section.collapseAll', 'Collapse all bots')}
        expandLabel={t('bots.section.expandAll', 'Expand all bots')}
        toggleAttributes={TOGGLE_ATTRIBUTES}
      />
    </span>
  )
}
