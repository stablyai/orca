import { ChevronDown, PanelTopOpen } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { activateWorktreeFromSidebar } from '@/lib/sidebar-worktree-activation'
import { cn } from '@/lib/utils'
import type { useAppStore } from '@/store'
import type { Worktree } from '../../../../shared/types'
import type { FolderSourceControlRefreshOutcome } from './folder-workspace-source-control-refresh'
import SourceControl from './SourceControl'

export function FolderWorkspaceSourceControlSection({
  worktree,
  repoName,
  expanded,
  statusEntries,
  refreshOutcome,
  onToggle
}: {
  worktree: Worktree
  repoName: string | null
  expanded: boolean
  statusEntries: ReturnType<typeof useAppStore.getState>['gitStatusByWorktree'][string] | undefined
  refreshOutcome: FolderSourceControlRefreshOutcome | null
  onToggle: () => void
}): React.JSX.Element {
  return (
    <Collapsible open={expanded} onOpenChange={onToggle}>
      <div className="overflow-hidden rounded-md border border-border bg-background">
        <div className="flex items-center transition-colors hover:bg-accent">
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left"
            >
              <ChevronDown
                className={cn('size-3.5 shrink-0 transition-transform', !expanded && '-rotate-90')}
              />
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs font-medium text-foreground">
                  {worktree.displayName}
                </div>
                {repoName ? (
                  <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                    {repoName}
                  </div>
                ) : null}
              </div>
              <div className="shrink-0 text-right text-[11px] text-muted-foreground">
                {formatStatusSummary(statusEntries, refreshOutcome)}
              </div>
            </button>
          </CollapsibleTrigger>
          <div className="pr-2">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="-mr-1 shrink-0 text-muted-foreground hover:text-foreground"
                  onClick={(event) => {
                    event.stopPropagation()
                    activateWorktreeFromSidebar(worktree.id)
                  }}
                  aria-label={translate(
                    'auto.components.rightSidebar.FolderWorkspaceSourceControlPanel.jumpToWorktree',
                    'Jump to worktree'
                  )}
                >
                  <PanelTopOpen className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={4}>
                {translate(
                  'auto.components.rightSidebar.FolderWorkspaceSourceControlPanel.jumpToWorktree',
                  'Jump to worktree'
                )}
              </TooltipContent>
            </Tooltip>
          </div>
        </div>
        <CollapsibleContent>
          <div className="border-t border-border">
            {expanded ? <SourceControl worktreeId={worktree.id} embedded /> : null}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  )
}

function formatStatusSummary(
  entries: readonly unknown[] | undefined,
  refreshOutcome: FolderSourceControlRefreshOutcome | null
): string {
  if (refreshOutcome?.kind === 'loading') {
    return translate(
      'auto.components.rightSidebar.FolderWorkspaceSourceControlPanel.loading',
      'Refreshing'
    )
  }
  if (refreshOutcome?.kind === 'unavailable') {
    return translate(
      'auto.components.rightSidebar.FolderWorkspaceSourceControlPanel.unavailableStatus',
      'Unavailable'
    )
  }
  if (refreshOutcome?.kind === 'failed') {
    return entries
      ? translate(
          'auto.components.rightSidebar.FolderWorkspaceSourceControlPanel.staleAfterFailed',
          '{{value0}} stale',
          { value0: entries.length }
        )
      : translate(
          'auto.components.rightSidebar.FolderWorkspaceSourceControlPanel.failed',
          'Refresh failed'
        )
  }
  if (refreshOutcome?.kind === 'fresh') {
    return formatFreshChangeCount(entries?.length ?? 0)
  }
  if (entries) {
    return translate(
      'auto.components.rightSidebar.FolderWorkspaceSourceControlPanel.cached',
      '{{value0}} cached',
      { value0: entries.length }
    )
  }
  return translate(
    'auto.components.rightSidebar.FolderWorkspaceSourceControlPanel.pending',
    'Status pending'
  )
}

function formatFreshChangeCount(count: number): string {
  return count === 1
    ? translate(
        'auto.components.rightSidebar.FolderWorkspaceSourceControlPanel.changeOne',
        '1 change'
      )
    : translate(
        'auto.components.rightSidebar.FolderWorkspaceSourceControlPanel.changeMany',
        '{{value0}} changes',
        { value0: count }
      )
}
