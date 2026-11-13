import React from 'react'
import { DetachedHeadBadge } from '@/components/DetachedHeadBadge'
import { useWslHostDistro, WslHostMark } from '@/components/wsl-host-mark/WslHostMark'
import { getWorktreeExecutionHostId } from '../../../../../../shared/execution-host'
import CacheTimer from '../activity/CacheTimer'
import { TruncatedSidebarLabel } from '../../truncated-sidebar-label'
import type { WorktreeCardController } from '../controller/use-worktree-card-controller'
import { useIsCloudHostRow } from '@/lib/orca-cloud/cloud-host-rows'
import {
  WorktreeCardDeleteQuickAction,
  WorktreeCardPrimaryBadge,
  WorktreeCardPrimaryStar,
  WorktreeCardRenameErrorButton,
  WorktreeCardRepoChip,
  WorktreeCardRuntimeHostMark,
  WorktreeCardSparseBadge
} from '../identity/worktree-card-header-items'
import {
  WorktreeCardConflictBadge,
  WorktreeCardFolderPath,
  WorktreeCardMetaRepoBadge
} from '../metadata/worktree-card-meta-items'
import { shouldBeginWorktreeRename } from '../controller/worktree-card-model'
import { WorktreeCardSshHostControl } from '../host/WorktreeCardSshHostControl'
import { WorktreeHostContextBadge } from '../host/WorktreeHostContextBadge'
import { WorktreeCardHostMark, WorktreeCardHostStateWord } from '../host/WorktreeCardHostMark'
import { WorktreeTitleInlineRename } from '../identity/WorktreeTitleInlineRename'
import { CloudAgentHeldMark } from '@/components/orca-cloud/CloudAgentHeldMark'
import { cardElement } from './card-template-compiler'

type Card = WorktreeCardController
const part = cardElement<Card>

// Why: a parent hover card already shows the full title, so the title skips its own tooltip.
const withoutTitleTooltip = (title: React.ReactElement): React.ReactElement => title

function title(props: Readonly<Record<string, unknown>>, card: Card): React.ReactNode {
  const { affiliateListMode, worktree } = card
  return (
    <>
      <WorktreeTitleInlineRename
        displayName={card.visibleCardTitle}
        disabled={card.isDeleting || affiliateListMode}
        showUnreadEmphasis={card.showUnreadEmphasis}
        dimReadTitle={props.dimWhenRead === true}
        className="text-[13px] leading-5"
        editingClassName="flex-1"
        titleWrapper={props.tooltip === false ? withoutTitleTooltip : undefined}
        onEditingChange={affiliateListMode ? undefined : card.setTitleRenaming}
        onRename={card.handleRenameTitle}
        beginEditing={
          !affiliateListMode &&
          shouldBeginWorktreeRename(card.renamingWorktreeId, worktree.id, card.renameRowKey)
        }
        onBeginEditingConsumed={
          affiliateListMode ? undefined : () => card.setRenamingWorktreeId(null)
        }
      />
      {/* N-03: the agent waits on its pane's strip (Orca Cloud): this mark is the signal away. */}
      {card.titleRenaming ? null : <CloudAgentHeldMark worktreeId={worktree.id} />}
    </>
  )
}

function sshControl(
  props: Readonly<Record<string, unknown>>,
  card: Card,
  actionOnly = false
): React.ReactNode {
  const { repo } = card
  if (!repo?.connectionId) {
    return null
  }
  return (
    <WorktreeCardSshHostControl
      targetId={repo.connectionId}
      targetLabel={card.sshTargetLabel || repo.displayName}
      status={card.sshStatus}
      targetRemoved={card.sshTargetRemoved}
      sshOwnerEnvironmentId={card.sshOwnerEnvironmentId}
      iconOnly={props.iconOnly === true}
      actionOnly={actionOnly}
      onPointerDown={card.stopQuickActionPointerPropagation}
    />
  )
}

function CardHostBadge({ card, label }: { card: Card; label: string }): React.JSX.Element {
  const wslDistro = useWslHostDistro(getWorktreeExecutionHostId(card.worktree, card.repo))
  return wslDistro ? <WslHostMark distro={wslDistro} /> : <WorktreeHostContextBadge label={label} />
}

function sidebarLabel(text: string, tooltip: unknown): React.ReactNode {
  return (
    <TruncatedSidebarLabel
      text={text}
      className="text-[11px] text-muted-foreground leading-none"
      // Why: a whole-card hover already shows the full identity; a nested tooltip would compete.
      tooltipEnabled={tooltip !== false}
    />
  )
}

/**
 * An Orca Cloud workspace's own checkout (owned or PAIRED) IS the workspace, not a repo's primary
 * checkout: no "primary" badge or star on it (CLOUD-PRIMARY-DELETE, PAIRED-BADGE).
 */
function NotOnCloudRow({
  worktree,
  children
}: {
  worktree: WorktreeCardController['worktree']
  children: React.ReactNode
}): React.JSX.Element | null {
  return useIsCloudHostRow(worktree) ? null : <>{children}</>
}

export const CARD_IDENTITY_PARTS = {
  Title: part(['dimWhenRead', 'tooltip'], (props, _children, card) => title(props, card)),
  RepoChip: part([], (_props, _children, { repo }) =>
    repo ? <WorktreeCardRepoChip repo={repo} /> : null
  ),
  // The one host mark (SSH, Orca server, recipe VM, Orca Cloud or this computer) in a 12px slot.
  HostMark: part(['runtime'], (props, _children, card) => (
    <WorktreeCardHostMark
      worktreeId={card.worktree.id}
      hostId={getWorktreeExecutionHostId(card.worktree, card.repo)}
      onPointerDown={card.stopQuickActionPointerPropagation}
      // Always icon-only in the 12px slot; classic cards show Connect on line 2 (SshConnect).
      sshControl={sshControl({ iconOnly: true }, card)}
      runtimeMark={
        props.runtime === true ? (
          <WorktreeCardRuntimeHostMark
            disconnected={card.isRuntimeDisconnected}
            hostLabel={card.runtimeHostLabel}
          />
        ) : undefined
      }
    />
  )),
  SshConnect: part([], (_props, _children, card) => sshControl({ iconOnly: false }, card, true)),
  HostStateWord: part([], (_props, _children, card) => (
    <WorktreeCardHostStateWord worktreeId={card.worktree.id} />
  )),
  RenameError: part([], (_props, _children, card) => (
    <WorktreeCardRenameErrorButton
      onPointerDown={card.stopQuickActionPointerPropagation}
      onOpen={card.handleOpenRenameErrorDialog}
    />
  )),
  PrimaryBadge: part(['hasHoverDetails'], (props, _children, card) => (
    <NotOnCloudRow worktree={card.worktree}>
      <WorktreeCardPrimaryBadge card={card} hasHoverDetails={props.hasHoverDetails === true} />
    </NotOnCloudRow>
  )),
  PrimaryStar: part([], (_props, _children, card) => (
    <NotOnCloudRow worktree={card.worktree}>
      <WorktreeCardPrimaryStar />
    </NotOnCloudRow>
  )),
  SparseBadge: part(['hasHoverDetails'], (props, _children, card) => (
    <WorktreeCardSparseBadge
      card={card}
      hasHoverDetails={props.hasHoverDetails === true}
      directories={card.worktree.sparseDirectories}
    />
  )),
  DeleteQuickAction: part([], (_props, _children, card) => (
    <WorktreeCardDeleteQuickAction
      onPointerDown={card.stopQuickActionPointerPropagation}
      onClick={card.handleWorkspaceQuickAction}
    />
  )),
  MetaRepoBadge: part([], (_props, _children, { repo }) =>
    repo ? <WorktreeCardMetaRepoBadge repo={repo} /> : null
  ),
  HostBadge: part(['label'], (props, _children, card) => (
    <CardHostBadge card={card} label={typeof props.label === 'string' ? props.label : ''} />
  )),
  Branch: part(['tooltip'], (props, _children, card) => sidebarLabel(card.branch, props.tooltip)),
  IdentityLabel: part(['tooltip'], (props, _children, card) =>
    card.identityDisplay ? sidebarLabel(card.identityDisplay, props.tooltip) : null
  ),
  FolderPath: part([], (_props, _children, { worktree }) => (
    <WorktreeCardFolderPath path={worktree.path} />
  )),
  DetachedHead: part([], (_props, _children, { detachedHeadDisplay }) =>
    detachedHeadDisplay ? (
      <DetachedHeadBadge
        display={detachedHeadDisplay}
        label="sidebar"
        side="right"
        className="h-[16px]"
      />
    ) : null
  ),
  ConflictBadge: part([], (_props, _children, { conflictOperation }) =>
    conflictOperation ? <WorktreeCardConflictBadge operation={conflictOperation} /> : null
  ),
  CacheTimer: part([], (_props, _children, { cacheStartedAt, cacheTtlMs }) =>
    cacheStartedAt != null ? <CacheTimer startedAt={cacheStartedAt} ttlMs={cacheTtlMs} /> : null
  )
}
