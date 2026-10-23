import React from 'react'
import { AlertTriangle } from 'lucide-react'

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { LinearAgentSkillSetupPrompt } from './LinearAgentSkillSetupPrompt'
import WorktreeCardAgents from './WorktreeCardAgents'
import { WorktreeLineageToggle } from './WorktreeLineageToggle'
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
    lineageCollapsed,
    lineageChildWorktreeIds,
    onLineageToggle,
    remoteBranchConflict,
    showInlineAgentList,
    agentActivityDisplayMode,
    compactInlineAgentRows,
    showLineageChildChip,
    lineageChildAriaLabel,
    lineageChildCount,
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
        <WorktreeLineageToggle
          childWorktreeIds={lineageChildWorktreeIds}
          collapsed={lineageCollapsed}
          ariaLabel={lineageChildAriaLabel}
          count={lineageChildCount}
          newCardStyle={newCardStyle}
          onToggle={onLineageToggle}
        />
      )}
    </>
  )
}
