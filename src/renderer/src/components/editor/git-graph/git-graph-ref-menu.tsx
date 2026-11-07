import { useMemo, useState } from 'react'
import { ArrowUpRight } from 'lucide-react'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import { selectWorktreesByRepo } from '@/store/workspace-record-selectors'
import type { gitGraphScope } from '@/lib/git-graph-tab'
import { gitGraphWorkspaceCatalog } from './git-graph-workspace-navigation'
import { translate } from '@/i18n/i18n'
import type { GitHistoryItemRef } from '../../../../../shared/git/history/git-history-types'
import type { Worktree } from '../../../../../shared/worktree/types'
import { cn } from '@/lib/utils'

export function useGitGraphWorkspaces(scope: ReturnType<typeof gitGraphScope>) {
  const worktrees = useAppStore(selectWorktreesByRepo)
  const repos = useAppStore((state) => state.repos)
  return useMemo(
    () =>
      new Map(
        gitGraphWorkspaceCatalog(scope, { repos, worktreesByRepo: worktrees }).map((row) => [
          row.branch.startsWith('refs/heads/') ? row.branch : `refs/heads/${row.branch}`,
          row
        ])
      ),
    [scope, worktrees, repos]
  )
}

export function GitGraphRefs({
  references,
  currentRefId,
  workspaces,
  onSwitch
}: {
  references: GitHistoryItemRef[]
  currentRefId?: string
  workspaces: Map<string, Worktree>
  onSwitch: (refId: string) => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [menuRef, setMenuRef] = useState<GitHistoryItemRef>()
  const current = references.find((ref) => ref.id === currentRefId)
  const inline = current ? [current] : []
  for (const ref of references) {
    if (inline.length === 2) {
      break
    }
    if (workspaces.has(ref.id) && ref !== current) {
      inline.push(ref)
    }
  }
  for (const ref of references) {
    if (inline.length === 2) {
      break
    }
    if (!inline.includes(ref)) {
      inline.push(ref)
    }
  }
  const badge = (ref: GitHistoryItemRef) => (
    <ContextMenuTrigger asChild key={ref.id}>
      <span
        onContextMenu={(event) => {
          event.stopPropagation()
          setMenuRef(ref)
        }}
        className={cn(
          'inline-flex min-w-0 max-w-full shrink items-center gap-1 rounded-full border px-1.5 text-2xs text-muted-foreground',
          ref.id === currentRefId && 'bg-accent font-medium text-foreground'
        )}
      >
        <span className="min-w-0 truncate" title={ref.name}>
          {ref.name}
        </span>
        {workspaces.has(ref.id) && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                className="shrink-0"
                aria-label={translate('gitGraph.switchWorkspace', 'Switch to workspace')}
                onClick={(event) => {
                  event.stopPropagation()
                  void onSwitch(ref.id)
                }}
              >
                <ArrowUpRight className="size-3" />
              </button>
            </TooltipTrigger>
            <TooltipContent>
              {translate('gitGraph.switchWorkspace', 'Switch to workspace')}
            </TooltipContent>
          </Tooltip>
        )}
      </span>
    </ContextMenuTrigger>
  )
  return (
    <ContextMenu
      onOpenChange={(open) => {
        if (!open) {
          setMenuRef(undefined)
        }
      }}
    >
      <div className="flex w-full min-w-0 gap-1">
        {inline.map(badge)}
        {references.length > inline.length && (
          <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
              <button className="shrink-0 text-2xs text-muted-foreground">
                +{references.length - inline.length}
              </button>
            </PopoverTrigger>
            {open && (
              <PopoverContent>
                <div className="max-h-72 space-y-1 overflow-auto scrollbar-sleek">
                  {references.filter((ref) => !inline.includes(ref)).map(badge)}
                </div>
              </PopoverContent>
            )}
          </Popover>
        )}
      </div>
      {menuRef && (
        <ContextMenuContent>
          <ContextMenuItem onSelect={() => void window.api.ui.writeClipboardText(menuRef.name)}>
            {translate('gitGraph.copyBranch', 'Copy branch name')}
          </ContextMenuItem>
          {workspaces.has(menuRef.id) && (
            <ContextMenuItem onSelect={() => void onSwitch(menuRef.id)}>
              {translate('gitGraph.switchWorkspace', 'Switch to workspace')}
            </ContextMenuItem>
          )}
        </ContextMenuContent>
      )}
    </ContextMenu>
  )
}
