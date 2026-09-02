import React from 'react'
import { AlertTriangle, ChevronDown, Workflow } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
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
    childWorkspaceShortLabel
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
          className={cn('relative mt-1 flex min-w-0 justify-start', !newCardStyle && '-ml-1')}
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
