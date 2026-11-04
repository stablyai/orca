import React from 'react'
import { Workflow } from 'lucide-react'
import { useAppStore } from '@/store'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'

export function SidebarWorkflowsNavButton(): React.JSX.Element {
  const openWorkflowsPage = useAppStore((s) => s.openWorkflowsPage)
  const active = useAppStore((s) => s.activeView === 'workflows')
  return (
    <button
      type="button"
      onClick={openWorkflowsPage}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] font-medium tracking-tight transition-colors',
        active
          ? 'bg-worktree-sidebar-accent text-worktree-sidebar-accent-foreground'
          : 'text-worktree-sidebar-foreground/60 hover:bg-worktree-sidebar-foreground/8'
      )}
    >
      <Workflow
        className={cn('size-4 shrink-0', !active && 'text-worktree-sidebar-foreground/30')}
        strokeWidth={active ? 2.25 : 1.75}
      />
      <span className="flex-1">
        {translate('auto.components.sidebar.SidebarWorkflowsNavButton.206c9ecaea', 'Workflows')}
      </span>
    </button>
  )
}
