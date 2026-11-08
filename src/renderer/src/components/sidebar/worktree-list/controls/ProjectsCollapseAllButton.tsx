import React from 'react'
import { ChevronsDownUp, ChevronsUpDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ShortcutKeyCombo } from '@/components/ShortcutKeyCombo'
import { useShortcutKeyDetails } from '@/hooks/useShortcutLabel'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store'

export function ProjectsCollapseAllButton({
  allCollapsed,
  onToggle
}: {
  allCollapsed: boolean
  onToggle: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const shortcut = useShortcutKeyDetails('sidebar.projects.toggleCollapse')
  const label = allCollapsed
    ? t('auto.components.sidebar.SidebarHeader.expandAllProjects', 'Expand all projects')
    : t('auto.components.sidebar.SidebarHeader.collapseAllProjects', 'Collapse all projects')
  const Icon = allCollapsed ? ChevronsUpDown : ChevronsDownUp
  const announcing = useAppStore((s) => s.activeContextualTourId === 'projects-collapse-all')

  // Own provider so a tooltip open on a neighbor can't skip this delay; clicks are the common case.
  return (
    <TooltipProvider delayDuration={1000} skipDelayDuration={0}>
      <Tooltip>
        <span
          data-projects-collapse-toggle=""
          className={cn(
            'flex shrink-0 overflow-hidden text-muted-foreground',
            'can-hover:w-0 can-hover:opacity-0',
            'can-hover:group-hover/sidebar-header:w-6 can-hover:group-hover/sidebar-header:opacity-100',
            'can-hover:focus-within:w-6 can-hover:focus-within:opacity-100',
            announcing && 'can-hover:w-6 can-hover:opacity-100'
          )}
        >
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              type="button"
              aria-label={label}
              onClick={onToggle}
            >
              <Icon />
            </Button>
          </TooltipTrigger>
        </span>
        <TooltipContent side="top" sideOffset={4}>
          <span className="flex items-center gap-2">
            {label}
            <ShortcutKeyCombo {...shortcut} />
          </span>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
