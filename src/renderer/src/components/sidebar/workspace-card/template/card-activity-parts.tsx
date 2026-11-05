import React from 'react'
import { LinearAgentSkillSetupPrompt } from '../../LinearAgentSkillSetupPrompt'
import type { WorktreeCardController } from '../controller/use-worktree-card-controller'
import WorktreeCardAgents from '../activity/WorktreeCardAgents'
import {
  renderWorktreeCardIndicators,
  WorktreeCardIdentityHover,
  WorktreeCardMetaDetailsHover
} from '../details/worktree-card-details-items'
import {
  WorktreeCardDeleteFailed,
  WorktreeCardRemoteBranchConflict
} from '../metadata/worktree-card-meta-items'
import { WorktreeCardStatusLane } from '../surface/worktree-card-status-lane'
import { WorktreeLineageToggle } from '../identity/WorktreeLineageToggle'
import { cardElement } from './card-template-compiler'

type Card = WorktreeCardController
const part = cardElement<Card>

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Wraps one layout element (its hover trigger) in the workspace details hover card. */
function detailsHover(
  props: Readonly<Record<string, unknown>>,
  children: React.ReactNode[],
  card: Card
): React.ReactNode {
  const child = children.find(
    (node): node is React.ReactElement<React.RefAttributes<HTMLElement>> =>
      React.isValidElement(node)
  )
  if (!child) {
    return null
  }
  return (
    <WorktreeCardIdentityHover
      card={card}
      branchName={optionalText(props.branchName)}
      workspaceTitle={optionalText(props.workspaceTitle)}
    >
      {child}
    </WorktreeCardIdentityHover>
  )
}

export const CARD_ACTIVITY_PARTS = {
  StatusLane: part(['unreadAction'], (props, _children, card) => (
    <WorktreeCardStatusLane card={card} showUnreadAction={props.unreadAction === true} />
  )),
  Agents: part(['tight'], (props, _children, card) => (
    <WorktreeCardAgents
      worktreeId={card.worktree.id}
      agents={card.agentActivityDisplayMode === 'compact' ? card.compactInlineAgentRows : undefined}
      // Why: counterbalance the card stack gap so agents right after the title read as one group.
      className={props.tight === true ? '-mt-1' : 'mt-0'}
    />
  )),
  RemoteBranchConflict: part([], (_props, _children, { remoteBranchConflict }) =>
    remoteBranchConflict ? (
      <WorktreeCardRemoteBranchConflict
        remote={remoteBranchConflict.remote}
        branchName={remoteBranchConflict.branchName}
      />
    ) : null
  ),
  DeleteFailed: part([], (_props, _children, { worktree }) =>
    worktree.removalError ? <WorktreeCardDeleteFailed error={worktree.removalError} /> : null
  ),
  LinearSetupPrompt: part([], (_props, _children, { repo, settings }) => (
    <LinearAgentSkillSetupPrompt
      linked
      remote={Boolean(repo?.connectionId || settings?.activeRuntimeEnvironmentId?.trim())}
      surface="modal"
      settings={settings}
    />
  )),
  ChildToggle: part([], (_props, _children, card) => (
    <WorktreeLineageToggle
      childWorktreeIds={card.lineageChildWorktreeIds}
      collapsed={card.lineageCollapsed}
      ariaLabel={card.lineageChildAriaLabel}
      label={card.childWorkspaceShortLabel}
      count={card.lineageChildCount}
      onToggle={card.onLineageToggle}
    />
  )),
  Indicators: part(['hover'], (props, _children, card) => {
    const content = renderWorktreeCardIndicators(card)
    return content && props.hover === 'meta' ? (
      <WorktreeCardMetaDetailsHover card={card}>{content}</WorktreeCardMetaDetailsHover>
    ) : (
      content
    )
  }),
  DetailsHover: part(['branchName', 'workspaceTitle'], detailsHover)
}
