import React from 'react'
import { Plus } from 'lucide-react'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'

const SidebarHeader = React.memo(function SidebarHeader() {
  const openModal = useAppStore((s) => s.openModal)
  const repos = useAppStore((s) => s.repos)
  const canCreateWorktree = repos.length > 0

  return (
    <div className="flex items-center justify-between px-4 pt-3 pb-1">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground select-none">
        Worktrees
      </span>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={() => {
              if (!canCreateWorktree) {
                return
              }
              openModal('create-worktree')
            }}
            aria-label="Add worktree"
            disabled={!canCreateWorktree}
          >
            <Plus className="size-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="right" sideOffset={6}>
          {canCreateWorktree ? 'New worktree (⌘N)' : 'Add a repo to create worktrees'}
        </TooltipContent>
      </Tooltip>
    </div>
  )
})

export default SidebarHeader
