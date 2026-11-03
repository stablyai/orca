import React from 'react'
import { GitFork, Plug } from 'lucide-react'
import { DetachedHeadBadge } from '@/components/DetachedHeadBadge'
import type { CardElementName } from '../../../../../../shared/workspace-cards/card-element-catalog'
import { CARD_ELEMENT_PROPS } from '../../../../../../shared/workspace-cards/card-element-catalog'
import type { Repo } from '../../../../../../shared/repo-types'
import StatusIndicator from '../../StatusIndicator'
import { TruncatedSidebarLabel } from '../../truncated-sidebar-label'
import {
  WorktreeCardPrimaryBadge,
  WorktreeCardPrimaryStar,
  WorktreeCardRenameErrorButton,
  WorktreeCardRepoChip,
  WorktreeCardRuntimeHostMark,
  WorktreeCardSparseBadge
} from '../../worktree-card-header-items'
import {
  WorktreeCardConflictBadge,
  WorktreeCardDeleteFailed,
  WorktreeCardFolderPath,
  WorktreeCardMetaRepoBadge,
  WorktreeCardRemoteBranchConflict
} from '../../worktree-card-meta-items'
import { WorktreeCardStatusLaneBox } from '../../worktree-card-status-lane'
import { WorktreeCardMetaBadges } from '../../WorktreeCardMeta'
import { WorktreeCardSshHostControl } from '../../WorktreeCardSshHostControl'
import { WorktreeCardStatusSlotView } from '../../WorktreeCardStatusSlot'
import { WorktreeHostContextBadge } from '../../WorktreeHostContextBadge'
import { WorktreeTitleInlineRename } from '../../WorktreeTitleInlineRename'
import { CARD_PRIMITIVES } from '../card-primitives'
import { cardElement, type CardElement } from '../card-template-compiler'
import type { CardPreviewAgent, CardPreviewScenario } from './card-preview-scenario'

type Scenario = CardPreviewScenario
const part = cardElement<Scenario>
const noop = (): void => {}
const withoutTitleTooltip = (title: React.ReactElement): React.ReactElement => title

function repoOf(scenario: Scenario): Repo | null {
  const repo = scenario.facts.repo
  return repo
    ? { id: repo.id, path: '/', displayName: repo.name, badgeColor: scenario.repoColor, addedAt: 0 }
    : null
}

const AGENT_STATUS = {
  working: 'working',
  blocked: 'permission',
  done: 'done',
  idle: 'active'
} as const

function PreviewAgentRow({ agent }: { agent: CardPreviewAgent }): React.JSX.Element {
  return (
    <div className="flex min-w-0 items-center gap-1.5 text-xs">
      <StatusIndicator status={AGENT_STATUS[agent.state]} aria-hidden="true" showTooltip={false} />
      <span className="shrink-0 font-medium">{agent.title}</span>
      <span className="min-w-0 flex-1 truncate text-muted-foreground">{agent.message}</span>
      <span className="shrink-0 text-2xs text-muted-foreground">{agent.ago}</span>
    </div>
  )
}

function sidebarLabel(text: string, tooltip: unknown): React.ReactNode {
  return (
    <TruncatedSidebarLabel
      text={text}
      className="text-[11px] text-muted-foreground leading-none"
      tooltipEnabled={tooltip !== false}
    />
  )
}

/** Orca's parts drawn from a scenario instead of the live store: same leaf components wherever
 *  they take plain props, simple stand-ins where the live part reads per-workspace store data. */
export const CARD_PREVIEW_ELEMENTS: Readonly<Record<CardElementName, CardElement<Scenario>>> = {
  ...CARD_PRIMITIVES,
  Title: part(CARD_ELEMENT_PROPS.Title, (props, _children, { facts }) => (
    <WorktreeTitleInlineRename
      displayName={facts.ws.title}
      disabled
      showUnreadEmphasis={facts.options.show.status && facts.ws.isUnread}
      dimReadTitle={props.dimWhenRead === true}
      className="text-[13px] leading-5"
      editingClassName="flex-1"
      titleWrapper={props.tooltip === false ? withoutTitleTooltip : undefined}
      onRename={noop}
    />
  )),
  RepoChip: part(CARD_ELEMENT_PROPS.RepoChip, (_props, _children, scenario) => {
    const repo = repoOf(scenario)
    return repo ? <WorktreeCardRepoChip repo={repo} /> : null
  }),
  SshControl: part(CARD_ELEMENT_PROPS.SshControl, (props, _children, scenario) => (
    <WorktreeCardSshHostControl
      targetId="card-preview"
      targetLabel={scenario.facts.repo?.name ?? ''}
      status={scenario.sshStatus}
      targetRemoved={false}
      sshOwnerEnvironmentId={null}
      iconOnly={props.iconOnly === true}
      onPointerDown={noop}
    />
  )),
  RuntimeHostMark: part(CARD_ELEMENT_PROPS.RuntimeHostMark, (_props, _children, { facts }) => (
    <WorktreeCardRuntimeHostMark
      disconnected={facts.host.runtimeDisconnected}
      hostLabel={facts.host.contextLabel}
    />
  )),
  RenameError: part(CARD_ELEMENT_PROPS.RenameError, () => (
    <WorktreeCardRenameErrorButton onPointerDown={noop} onOpen={noop} />
  )),
  PrimaryBadge: part(CARD_ELEMENT_PROPS.PrimaryBadge, () => <WorktreeCardPrimaryBadge />),
  PrimaryStar: part(CARD_ELEMENT_PROPS.PrimaryStar, () => <WorktreeCardPrimaryStar />),
  SparseBadge: part(CARD_ELEMENT_PROPS.SparseBadge, () => (
    <WorktreeCardSparseBadge directories={undefined} />
  )),
  DeleteQuickAction: part(CARD_ELEMENT_PROPS.DeleteQuickAction, () => null),
  MetaRepoBadge: part(CARD_ELEMENT_PROPS.MetaRepoBadge, (_props, _children, scenario) => {
    const repo = repoOf(scenario)
    return repo ? <WorktreeCardMetaRepoBadge repo={repo} /> : null
  }),
  HostBadge: part(CARD_ELEMENT_PROPS.HostBadge, (props) => (
    <WorktreeHostContextBadge label={typeof props.label === 'string' ? props.label : ''} />
  )),
  Branch: part(CARD_ELEMENT_PROPS.Branch, (props, _children, { facts }) =>
    sidebarLabel(facts.ws.branch, props.tooltip)
  ),
  IdentityLabel: part(CARD_ELEMENT_PROPS.IdentityLabel, (props, _children, { facts }) =>
    facts.ws.identity ? sidebarLabel(facts.ws.identity, props.tooltip) : null
  ),
  FolderPath: part(CARD_ELEMENT_PROPS.FolderPath, (_props, _children, { facts }) => (
    <WorktreeCardFolderPath path={facts.ws.path} />
  )),
  DetachedHead: part(CARD_ELEMENT_PROPS.DetachedHead, (_props, _children, { detachedHead }) =>
    detachedHead ? (
      <DetachedHeadBadge display={detachedHead} label="sidebar" side="right" className="h-[16px]" />
    ) : null
  ),
  ConflictBadge: part(CARD_ELEMENT_PROPS.ConflictBadge, (_props, _children, { facts }) =>
    facts.git.conflictOperation === 'merge' ||
    facts.git.conflictOperation === 'rebase' ||
    facts.git.conflictOperation === 'cherry-pick' ? (
      <WorktreeCardConflictBadge operation={facts.git.conflictOperation} />
    ) : null
  ),
  CacheTimer: part(CARD_ELEMENT_PROPS.CacheTimer, () => null),
  StatusLane: part(CARD_ELEMENT_PROPS.StatusLane, (props, _children, scenario) => {
    const { facts } = scenario
    const newCardStyle = facts.options.style === 'new'
    return (
      <WorktreeCardStatusLaneBox newCardStyle={newCardStyle} affiliateList={false}>
        <WorktreeCardStatusSlotView
          status={scenario.status}
          isSleeping={scenario.isSleeping}
          showStatus={facts.options.show.status}
          showUnreadAction={props.unreadAction === true}
          isUnread={facts.ws.isUnread}
          unreadTooltip=""
          onPointerDown={noop}
          onToggleUnread={noop}
          prDisplay={scenario.review}
          newCardStyle={newCardStyle}
          hasBranchIdentity={facts.ws.branch.length > 0}
        />
      </WorktreeCardStatusLaneBox>
    )
  }),
  Agents: part(CARD_ELEMENT_PROPS.Agents, (props, _children, { agents }) =>
    agents.length > 0 ? (
      <div className={props.tight === true ? '-mt-1 flex flex-col gap-1' : 'flex flex-col gap-1'}>
        {agents.map((agent) => (
          <PreviewAgentRow key={`${agent.title}-${agent.state}`} agent={agent} />
        ))}
      </div>
    ) : null
  ),
  RemoteBranchConflict: part(
    CARD_ELEMENT_PROPS.RemoteBranchConflict,
    (_props, _children, { facts }) =>
      facts.git.remoteBranchConflict ? (
        <WorktreeCardRemoteBranchConflict
          remote={facts.git.remoteBranchConflict.remote}
          branchName={facts.git.remoteBranchConflict.branch}
        />
      ) : null
  ),
  DeleteFailed: part(CARD_ELEMENT_PROPS.DeleteFailed, (_props, _children, { facts }) =>
    facts.ws.removalError ? <WorktreeCardDeleteFailed error={facts.ws.removalError} /> : null
  ),
  LinearSetupPrompt: part(CARD_ELEMENT_PROPS.LinearSetupPrompt, () => null),
  ChildToggle: part(CARD_ELEMENT_PROPS.ChildToggle, (_props, _children, { facts }) => (
    <span className="inline-flex items-center gap-1 text-2xs text-muted-foreground">
      <GitFork className="size-3" />
      {facts.lineage.childCount}
    </span>
  )),
  Indicators: part(CARD_ELEMENT_PROPS.Indicators, (_props, _children, scenario) => {
    const { facts } = scenario
    const review = facts.options.style === 'new' ? null : scenario.review
    if (!review && !scenario.issue && facts.ports.count === 0 && !facts.ws.comment.trim()) {
      return null
    }
    return (
      <div className="flex shrink-0 items-center gap-1">
        {facts.ports.count > 0 ? <Plug className="size-3.5 text-muted-foreground/70" /> : null}
        <WorktreeCardMetaBadges
          linkedItemCount={facts.links.count}
          referenceItems={[]}
          issue={scenario.issue}
          linearIssue={null}
          jiraIssue={null}
          review={review}
          comment={facts.ws.comment}
          automationProvenance={null}
          cliProvenance={null}
          className="ml-0 pr-0"
        />
      </div>
    )
  }),
  // A preview never opens the hover card; it draws the identity block it wraps.
  DetailsHover: part(CARD_ELEMENT_PROPS.DetailsHover, (_props, children) => children)
}
