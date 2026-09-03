import React, { useCallback } from 'react'
import { ChevronsDownUp, ChevronsUpDown } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import {
  collapseAllSectionKeys,
  expandAllSectionKeys,
  resolveCollapseAllState
} from './worktree-list/grouping/section-header-keys'

type SidebarCollapseAllButtonProps = {
  headerKeys: readonly string[]
  collapsedGroups: ReadonlySet<string>
  onCollapseAll: () => void
  onExpandAll: () => void
  compact: boolean
}

export function SidebarCollapseAllButton({
  headerKeys,
  collapsedGroups,
  onCollapseAll,
  onExpandAll,
  compact
}: SidebarCollapseAllButtonProps): React.JSX.Element | null {
  useTranslation()
  const state = resolveCollapseAllState(headerKeys, collapsedGroups)
  if (state === 'none') {
    return null
  }

  const collapse = state === 'collapse'
  const label = collapse
    ? translate('auto.components.sidebar.SidebarCollapseAllButton.collapseAll', 'Collapse all')
    : translate('auto.components.sidebar.SidebarCollapseAllButton.expandAll', 'Expand all')
  const handleAction = collapse ? onCollapseAll : onExpandAll
  const icon = collapse ? (
    <ChevronsDownUp className="size-3.5" strokeWidth={2.25} />
  ) : (
    <ChevronsUpDown className="size-3.5" strokeWidth={2.25} />
  )

  if (compact) {
    return (
      <DropdownMenuItem onSelect={handleAction}>
        {icon}
        {label}
      </DropdownMenuItem>
    )
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="text-muted-foreground hover:text-foreground"
          aria-label={label}
          data-workspace-board-preserve-open=""
          onClick={handleAction}
        >
          {icon}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}

export function SidebarCollapseAllMenuItem(): React.JSX.Element | null {
  const headerKeys = useAppStore((s) => s.sidebarSectionHeaderKeys)
  const collapsedGroups = useAppStore((s) => s.collapsedGroups)
  const setCollapsedGroups = useAppStore((s) => s.setCollapsedGroups)
  const collapseAllSections = useCallback(() => {
    setCollapsedGroups(collapseAllSectionKeys(collapsedGroups, headerKeys))
  }, [collapsedGroups, headerKeys, setCollapsedGroups])
  const expandAllSections = useCallback(() => {
    setCollapsedGroups(expandAllSectionKeys(collapsedGroups))
  }, [collapsedGroups, setCollapsedGroups])

  return (
    <SidebarCollapseAllButton
      headerKeys={headerKeys}
      collapsedGroups={collapsedGroups}
      onCollapseAll={collapseAllSections}
      onExpandAll={expandAllSections}
      compact
    />
  )
}
