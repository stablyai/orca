import React from 'react'

import { LinearAgentSkillSetupPrompt } from '../../LinearAgentSkillSetupPrompt'
import WorktreeCardAgents from '../activity/WorktreeCardAgents'
import {
  WorktreeCardDeleteFailed,
  WorktreeCardRemoteBranchConflict
} from '../metadata/worktree-card-meta-items'
import { WorktreeLineageToggle } from '../identity/WorktreeLineageToggle'
import type { WorktreeCardPresentation } from './worktree-card-presentation'
import type { WorktreeCardController } from '../controller/use-worktree-card-controller'

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
    lineageCollapsed,
    lineageChildWorktreeIds,
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
        <WorktreeCardRemoteBranchConflict
          remote={remoteBranchConflict.remote}
          branchName={remoteBranchConflict.branchName}
        />
      )}

      {/* The host retains failed deletes until resolved; show its path-leading error in a tooltip. */}
      {worktree.removalError && !isDeleting ? (
        <WorktreeCardDeleteFailed error={worktree.removalError} />
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
          executionHostId={worktree.hostId}
          agents={agentActivityDisplayMode === 'compact' ? compactInlineAgentRows : undefined}
          className={hasMetaRow || remoteBranchConflict ? 'mt-0' : '-mt-1'}
        />
      )}

      {showLineageChildChip && (
        <WorktreeLineageToggle
          childWorktreeIds={lineageChildWorktreeIds}
          collapsed={lineageCollapsed}
          ariaLabel={lineageChildAriaLabel}
          label={childWorkspaceShortLabel}
          count={card.lineageChildCount}
          onToggle={onLineageToggle}
        />
      )}
    </>
  )
}
