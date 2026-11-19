import type React from 'react'
import { SectionCollapseAllButton } from '@/components/sidebar/worktree-list/controls/SectionCollapseAllButton'
import { useTranslate } from '@/i18n/use-translate'
import type { AiVaultCollapseAll } from './ai-vault-collapse-all'

/** Collapse or expand every Session History group, as Projects and Bots do for theirs. */
export function AiVaultCollapseAllButton({
  collapseAll
}: {
  collapseAll: AiVaultCollapseAll
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <SectionCollapseAllButton
      allCollapsed={collapseAll.allCollapsed}
      onToggle={collapseAll.toggle}
      collapseLabel={t('sessionSearch.panel.collapseAllGroups', 'Collapse all groups')}
      expandLabel={t('sessionSearch.panel.expandAllGroups', 'Expand all groups')}
    />
  )
}
