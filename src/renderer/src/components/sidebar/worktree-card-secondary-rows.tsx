import { AlertTriangle, ChevronDown, FolderTree, Workflow } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useWorktreeLineageTreeStore } from '@/store/worktree-lineage-tree-store'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { LinearAgentSkillSetupPrompt } from './LinearAgentSkillSetupPrompt'
import WorktreeCardAgents from './WorktreeCardAgents'
import type { WorktreeCardPresentation } from './worktree-card-presentation'
import type { WorktreeCardController } from './use-worktree-card-controller'

export function WorktreeCardSecondaryRows({
  card,
  presentation
}: {
  card: WorktreeCardController
  presentation: WorktreeCardPresentation
}): React.JSX.Element {
  const {
    worktree,
    repo,
    settings,
    isActive,
    newCardStyle,
    lineageChildren,
    lineageCollapsed,
    onLineageToggle,
    remoteBranchConflict,
    showInlineAgentList,
    agentActivityDisplayMode,
    compactInlineAgentRows,
    showLineageChildChip,
    lineageChildAriaLabel,
    childWorkspaceShortLabel,
    isDeleting
  } = card
  const { hasMetaRow } = presentation

  return (
    <>
      {remoteBranchConflict && (
        <div className="mt-0.5 flex items-start gap-1.5 rounded border border-amber-500/25 bg-amber-500/5 px-1.5 py-1 text-[10.5px] leading-snug text-amber-700 dark:text-amber-300">
          <AlertTriangle className="mt-[1px] size-3 shrink-0" />
          <span className="min-w-0 flex-1">
            {translate(
              'auto.components.sidebar.WorktreeCard.a88c92d0e3',
              '{{value0}}/{{value1}} already exists.',
              {
                value0: remoteBranchConflict.remote,
                value1: remoteBranchConflict.branchName
              }
            )}
          </span>
        </div>
      )}

      {/* Why from the row: the host lists a failed delete until it is retried, forgotten or gone.
          Why a tooltip: the error leads with the path; the Delete dialog shows it inline too. */}
      {worktree.removalError && !isDeleting ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <div
              className="mt-0.5 flex items-center gap-1.5 text-[11px] leading-snug text-destructive"
              data-worktree-card-delete-failed=""
            >
              <AlertTriangle className="size-3 shrink-0" />
              <span className="min-w-0 truncate">
                {translate('auto.components.sidebar.WorktreeCard.deleteFailed', 'Delete failed')}
              </span>
            </div>
          </TooltipTrigger>
          <TooltipContent side="right" sideOffset={8} className="max-w-72 break-words">
            {worktree.removalError}
          </TooltipContent>
        </Tooltip>
      ) : null}

      {isActive && worktree.linkedLinearIssue ? (
        <LinearAgentSkillSetupPrompt
          linked
          remote={Boolean(repo?.connectionId || settings?.activeRuntimeEnvironmentId?.trim())}
          surface="modal"
          settings={settings}
        />
      ) : null}

      {/* Why: counterbalance the card stack gap (-mt-1) so agents right after the title read as one header group. */}
      {showInlineAgentList && (
        <WorktreeCardAgents
          worktreeId={worktree.id}
          agents={agentActivityDisplayMode === 'compact' ? compactInlineAgentRows : undefined}
          className={hasMetaRow || remoteBranchConflict ? 'mt-0' : '-mt-1'}
        />
      )}

      {showLineageChildChip && (
        <div
          className={cn(
            'relative mt-1 flex min-w-0 items-center gap-1 justify-start',
            !newCardStyle && '-ml-1'
          )}
          style={{
            color: 'color-mix(in srgb, var(--muted-foreground) 42%, var(--worktree-sidebar))'
          }}
        >
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                className="relative z-10 h-[18px] max-w-[8rem] gap-1 rounded-md border border-worktree-sidebar-border bg-worktree-sidebar px-1.5 text-[10px] font-medium leading-none text-muted-foreground shadow-none hover:bg-worktree-sidebar-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-worktree-sidebar-ring"
                aria-label={lineageChildAriaLabel}
                aria-expanded={!lineageCollapsed}
                onClick={onLineageToggle}
              >
                <Workflow className="size-2.5" />
                <span className="truncate">{childWorkspaceShortLabel}</span>
                <ChevronDown
                  className={cn('size-2.5 transition-transform', lineageCollapsed && '-rotate-90')}
                />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right" sideOffset={8}>
              {lineageCollapsed
                ? translate(
                    'auto.components.sidebar.WorktreeCard.8cb634cda6',
                    'Show child workspaces'
                  )
                : translate(
                    'auto.components.sidebar.WorktreeCard.57eaa61b55',
                    'Hide child workspaces'
                  )}
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                className="relative z-10 h-[18px] w-[18px] p-0 rounded-md border border-worktree-sidebar-border bg-worktree-sidebar text-muted-foreground shadow-none hover:bg-worktree-sidebar-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-worktree-sidebar-ring"
                aria-label={translate(
                  'auto.components.sidebar.lineageTree.viewHierarchy',
                  'View tree hierarchy'
                )}
                onClick={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  useWorktreeLineageTreeStore
                    .getState()
                    .openLineageTree({ worktreeId: worktree.id })
                }}
              >
                <FolderTree className="size-2.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right" sideOffset={8}>
              {translate(
                'auto.components.sidebar.lineageTree.viewHierarchy',
                'View tree hierarchy'
              )}
            </TooltipContent>
          </Tooltip>
        </div>
      )}

      {!newCardStyle && lineageChildren && (
        <div className="-ml-[1.125rem] mt-1.5 w-[calc(100%+1.125rem)] space-y-1">
          {lineageChildren}
        </div>
      )}
    </>
  )
}
