import React, { useCallback, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'

import type { DashboardAgentRow } from '@/components/dashboard/useDashboardData'
import type { HostScopedWorktreeKey } from '../../../../shared/worktree/host-qualified-identity'
import { useNow } from '@/hooks/use-now'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { canConnectSshStatus, isConnectingSshStatus } from '@/ssh/ssh-connection-recoverability'
import { useAppStore } from '@/store'
import type { WorktreeCardController } from './workspace-card/controller/use-worktree-card-controller'
import { useWorktreeAgentRows } from './workspace-card/activity/useWorktreeAgentRows'
import { selectAgentRowsUnread } from './workspace-card/activity/worktree-card-agent-ack-inputs'
import { selectSendTargetControlInputs } from './workspace-card/activity/worktree-card-send-target-inputs'
import { dispatchSuppressScrollAdjustment } from './workspace-card/activity/use-worktree-agent-list-model'
import { WorktreeCardSshHostControl } from './workspace-card/host/WorktreeCardSshHostControl'
import { WorktreeCardIdentityHover } from './worktree-card-identity-hover'
import type { WorktreeCardPresentation } from './workspace-card/surface/worktree-card-presentation'
import { WorktreeCardSecondaryRows } from './workspace-card/surface/worktree-card-secondary-rows'
import {
  collectLineageSlotTargets,
  useCollapsedLineageSlots,
  useLineageLatestAt
} from './worktree-card-slot-rollup'
import { titleRowSlot, type SlotException } from './worktree-card-slot-signal'
import { buildSlotAgentSignals, type SlotAgentSignals } from './worktree-card-slot-agent-signals'
import {
  WorktreeCardDeleteQuickAction,
  WorktreeCardRenameFailedButton
} from './worktree-card-title-actions'
import { getWorktreeCardHost, WorktreeCardHostName } from './worktree-card-host-name'
import { WorktreeCardChildrenChip } from './worktree-card-children-chip'
import { WorktreeCardSlot, WorktreeCardTitlePills, WorktreeCardTitleTime } from './WorktreeCardSlot'
import {
  WorktreeCardLeadingBadge,
  WorktreeCardLeadingIcon,
  type LeadingIconBadge
} from './worktree-card-leading-icon'
import { getWorktreeCardIconStyle } from '../../../../shared/worktree/card-display-settings-types'
import { WorktreeCardPrRollup } from './worktree-card-pr-rollup'
import { openWorktreeCardOwnReview, WorktreeCardPrMark } from './worktree-card-pr-mark'
import {
  expandWorkspaceUnreadTargets,
  slotTargetsFromAgentLines,
  slotTargetsOfKind,
  workspaceUnreadTarget
} from './worktree-card-slot-targets'
import { WorktreeCardSlotAgentLines } from './WorktreeCardSlotAgentLines'
import { shouldBeginWorktreeRename } from './workspace-card/controller/worktree-card-model'
import { WorktreeTitleInlineRename } from './workspace-card/identity/WorktreeTitleInlineRename'
import { WorktreeCardMetaRow } from './workspace-card/metadata/worktree-card-meta-row'

const NO_DESCENDANTS: readonly HostScopedWorktreeKey[] = []

function useSlotAgentSignals(agents: DashboardAgentRow[]): SlotAgentSignals {
  // Same acknowledgement records the 1.0 rows read, so unread means the same on both cards.
  const unread = useAppStore(useShallow((s) => selectAgentRowsUnread(s, agents)))
  return useMemo(() => buildSlotAgentSignals(agents, unread), [agents, unread])
}

function StaleSlotText({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <span className="shrink-0 whitespace-nowrap text-3xs leading-none italic text-muted-foreground/70">
      {children}
    </span>
  )
}

/** While an SSH host is down the slot is the way back: reconnect, or why it can't. */
function SshHostSlot({
  card,
  label
}: {
  card: WorktreeCardController
  label: string
}): React.JSX.Element {
  const { repo, sshStatus, sshTargetRemoved, sshOwnerEnvironmentId } = card
  if (sshTargetRemoved) {
    return (
      <StaleSlotText>{translate('sidebar.cardSlot.hostRemoved', 'host removed')}</StaleSlotText>
    )
  }
  if (repo?.connectionId && (isConnectingSshStatus(sshStatus) || canConnectSshStatus(sshStatus))) {
    return (
      <WorktreeCardSshHostControl
        targetId={repo.connectionId}
        targetLabel={label}
        status={sshStatus}
        targetRemoved={false}
        sshOwnerEnvironmentId={sshOwnerEnvironmentId}
        iconOnly={false}
        onPointerDown={card.stopQuickActionPointerPropagation}
      />
    )
  }
  return <StaleSlotText>{translate('sidebar.cardSlot.disconnected', 'disconnected')}</StaleSlotText>
}

/** Experimental 2.0 card: name and one right-hand slot, then one line per agent. */
export function WorktreeCardSlotContent({
  card,
  presentation,
  open: openRequested,
  onToggleOpen
}: {
  card: WorktreeCardController
  presentation: WorktreeCardPresentation
  open: boolean
  onToggleOpen: () => void
}): React.JSX.Element {
  const {
    worktree,
    affiliateListMode,
    renameRowKey,
    visibleCardTitle,
    isDeleting,
    isRuntimeDisconnected,
    setTitleRenaming,
    handleRenameTitle,
    renamingWorktreeId,
    setRenamingWorktreeId,
    showInlineAgentList,
    showDeleteQuickAction,
    showLineageChildChip,
    lineageCollapsed,
    lineageDescendantIdentities,
    lineageChildIdentities,
    onLineageToggle,
    lineageChildAriaLabel,
    childWorkspaceShortLabel,
    settings
  } = card
  const agents = useWorktreeAgentRows(worktree.id, true, worktree.hostId)
  const signals = useSlotAgentSignals(agents)
  const lines = signals.rootLines
  const now = useNow(30_000)
  const host = getWorktreeCardHost(card)
  const sshDown = host?.kind === 'ssh' && host.down
  const offline = isRuntimeDisconnected || sshDown
  const markedByUser = useAppStore((s) => Boolean(s.workspacesMarkedUnreadByUser[worktree.id]))
  // Picking a send target turns the agent lines into the picker, so they can't stay folded.
  const pickingSendTarget = useAppStore(
    (s) => selectSendTargetControlInputs(s, worktree.id).targetMode !== null
  )
  const open = openRequested || pickingSendTarget
  const descendants = lineageDescendantIdentities ?? NO_DESCENDANTS
  // A closed card hides its children too, so the title slot speaks for them.
  const lineageHidden = lineageCollapsed || !open
  const collapsedLineage = useCollapsedLineageSlots(lineageHidden ? descendants : NO_DESCENDANTS)
  const lineageLatestAt = useLineageLatestAt(descendants)
  const hasLines = showInlineAgentList && lines.length > 0
  const canOpen = hasLines || showLineageChildChip
  // An open card lists its agents directly; opening the card is the only fold.
  const showLines = open && hasLines
  const agentUnread = signals.allSignals.some((signal) => signal.kind === 'unread')
  // Any unread source counts (a terminal tab, a pane, the user's mark) unless a visible line already shows it.
  const workspaceUnread =
    worktree.isUnread && !(showLines && agentUnread) ? { manual: markedByUser } : null
  // The icon badge and pills speak for what's hidden; a visible agent line shows its own state.
  const titleSlot = titleRowSlot({
    offline,
    lines: signals.allSignals,
    collapsedLineage,
    workspaceUnread,
    ownLinesShown: showLines,
    lastActivityAt: worktree.lastActivityAt > 0 ? worktree.lastActivityAt : null,
    lineageLatestAt
  })
  const titleExceptions = titleSlot.kind === 'status' ? titleSlot.exceptions : []
  const iconBadge =
    titleExceptions.find(
      (exception): exception is LeadingIconBadge =>
        exception.kind === 'unread' || exception.kind === 'working'
    ) ?? null
  const worktreeLastActivityAt = worktree.lastActivityAt > 0 ? worktree.lastActivityAt : null
  const workspaceUnreadShown = workspaceUnread !== null
  const resolveTitleTargets = useCallback(
    (kind: SlotException['kind']) => {
      const state = useAppStore.getState()
      return slotTargetsOfKind(
        expandWorkspaceUnreadTargets(state, [
          ...(showLines ? [] : slotTargetsFromAgentLines(worktree.id, signals, worktree.hostId)),
          ...(lineageHidden ? collectLineageSlotTargets(state, descendants) : []),
          ...(workspaceUnreadShown
            ? [workspaceUnreadTarget(worktree.id, worktreeLastActivityAt, worktree.hostId)]
            : [])
        ]),
        kind
      )
    },
    [
      descendants,
      lineageHidden,
      showLines,
      signals,
      workspaceUnreadShown,
      worktree.id,
      worktree.hostId,
      worktreeLastActivityAt
    ]
  )
  const showDetailsRow =
    settings?.worktreeCardDetailsRow === true &&
    (presentation.hasMetaRow || presentation.detailsAndPorts !== null)
  // Unread and bold are one signal: any unread the card speaks for, its own or a hidden child's.
  const titleBold =
    worktree.isUnread ||
    agentUnread ||
    titleExceptions.some((exception) => exception.kind === 'unread')
  // Only a closed card needs the stub; an open one already shows its children chip.
  const subtreeHidden = !open && descendants.length > 0
  const iconStyle = getWorktreeCardIconStyle(settings)

  const agentLines = showLines ? (
    <WorktreeCardSlotAgentLines
      worktreeId={worktree.id}
      agents={agents}
      signals={signals}
      now={now}
      offline={offline}
      cacheTimersActive={showLines}
    />
  ) : null

  const slotRows = (
    <>
      {agentLines}
      {open && showLineageChildChip ? (
        <div className="mt-[3px] flex min-w-0 pr-1.5 pl-[var(--worktree-card-text-inset,24px)]">
          <WorktreeCardChildrenChip
            childIdentities={lineageChildIdentities}
            lineageSource={descendants}
            collapsed={lineageCollapsed}
            label={childWorkspaceShortLabel}
            ariaLabel={lineageChildAriaLabel}
            onToggle={onLineageToggle}
          />
        </div>
      ) : null}
    </>
  )

  const toggleCard = (event: React.MouseEvent<HTMLElement>): void => {
    dispatchSuppressScrollAdjustment()
    // Opening a card shows everything it holds, its child workspaces included.
    if (!open && lineageCollapsed && onLineageToggle) {
      onLineageToggle(event)
    }
    onToggleOpen()
  }
  const openOwnReview = (event: React.MouseEvent): void => openWorktreeCardOwnReview(card, event)
  const openToggleLabel = open
    ? translate('sidebar.cardSlot.closeCard', 'Hide workspace activity')
    : translate('sidebar.cardSlot.openCard', 'Show workspace activity')

  return (
    <div
      // Clip sideways only: the leading icon's older tabs peek above the title row. Without an
      // icon, nothing needs clipping and the name's badge hangs into the card's left padding.
      className={cn('flex w-full min-w-0 flex-col', iconStyle !== 'none' && 'overflow-x-clip')}
      // Rows under the name start where its text does: past the icon, or flush without one.
      data-worktree-card-icon={iconStyle}
      data-worktree-card-open={open || undefined}
      data-worktree-card-parent-content=""
      data-worktree-card-style="experimental-2"
    >
      <WorktreeCardIdentityHover card={card} presentation={presentation}>
        <div
          className="group/worktree-card flex min-w-0 flex-col"
          data-worktree-card-hover-trigger=""
          // The chevron is a small target; a plain click anywhere on the header toggles too.
          onClick={(event) => {
            if (
              canOpen &&
              !pickingSendTarget &&
              !event.defaultPrevented &&
              event.detail <= 1 &&
              !(event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) &&
              !window.getSelection()?.toString()
            ) {
              toggleCard(event)
            }
          }}
        >
          <div
            className={cn(
              'relative flex h-5 min-w-0 items-center gap-1.5 pr-1.5',
              subtreeHidden && 'mb-3'
            )}
          >
            {iconStyle === 'none' ? (
              // No icon to sit on, so the badge rides the name's corner without taking a column.
              iconBadge ? (
                <WorktreeCardLeadingBadge
                  badge={iconBadge}
                  className="worktree-card-name-badge"
                  resolveTargets={resolveTitleTargets}
                />
              ) : null
            ) : (
              <WorktreeCardLeadingIcon
                worktreeId={worktree.id}
                name={visibleCardTitle}
                iconStyle={iconStyle}
                mark={
                  iconStyle === 'pr' ? (
                    <WorktreeCardPrMark
                      review={card.statusLaneReview}
                      hasBranch={Boolean(card.branchIdentityDisplay)}
                      onOpen={openOwnReview}
                      onPointerDown={card.stopQuickActionPointerPropagation}
                    />
                  ) : undefined
                }
                badge={iconBadge}
                offline={offline}
                resolveTargets={resolveTitleTargets}
              />
            )}
            {subtreeHidden ? (
              // The stub under a closed card says it holds child workspaces; clicking it opens them.
              <button
                type="button"
                className="worktree-card-thread-stub"
                aria-label={translate(
                  'auto.components.sidebar.WorktreeList.showChildWorkspaces',
                  'Show {{count}} child workspaces',
                  {
                    count: card.lineageChildCount,
                    defaultValue_one: 'Show {{count}} child workspace'
                  }
                )}
                disabled={pickingSendTarget}
                onPointerDown={card.stopQuickActionPointerPropagation}
                onClick={(event) => {
                  event.stopPropagation()
                  toggleCard(event)
                }}
              />
            ) : null}
            <WorktreeTitleInlineRename
              displayName={visibleCardTitle}
              disabled={isDeleting || affiliateListMode}
              showUnreadEmphasis={titleBold}
              dimReadTitle
              className="text-xs leading-5"
              editingClassName="flex-1"
              titleWrapper={presentation.titleWrapper}
              onEditingChange={affiliateListMode ? undefined : setTitleRenaming}
              onRename={handleRenameTitle}
              beginEditing={
                !affiliateListMode &&
                shouldBeginWorktreeRename(renamingWorktreeId, worktree.id, renameRowKey)
              }
              onBeginEditingConsumed={
                affiliateListMode ? undefined : () => setRenamingWorktreeId(null)
              }
            />
            {host ? <WorktreeCardHostName host={host} /> : null}
            <WorktreeCardRenameFailedButton card={card} />
            <span className="ml-auto flex shrink-0 items-center gap-1">
              {showDeleteQuickAction ? <WorktreeCardDeleteQuickAction card={card} /> : null}
              {sshDown && host ? null : (
                <WorktreeCardTitlePills
                  exceptions={titleExceptions}
                  resolveTargets={resolveTitleTargets}
                />
              )}
              <WorktreeCardPrRollup
                // The PR icon style already shows this workspace's own review up front.
                own={iconStyle === 'pr' ? null : card.statusLaneReview}
                ownRepresentsDescendant={card.statusPrDisplay != null}
                onOpenOwn={openOwnReview}
                hiddenDescendants={lineageHidden ? descendants : NO_DESCENDANTS}
              />
              {sshDown && host ? (
                <SshHostSlot card={card} label={host.label} />
              ) : titleSlot.kind === 'offline' ? (
                <WorktreeCardSlot signal={titleSlot} now={now} />
              ) : null}
              {!offline || canOpen ? (
                <WorktreeCardTitleTime
                  exceptions={titleExceptions}
                  at={titleSlot.kind === 'status' ? titleSlot.at : null}
                  now={now}
                  disclosureOnly={offline}
                  toggle={
                    canOpen
                      ? {
                          open,
                          label: openToggleLabel,
                          disabled: pickingSendTarget,
                          onPointerDown: card.stopQuickActionPointerPropagation,
                          onToggle: toggleCard
                        }
                      : null
                  }
                />
              ) : null}
            </span>
          </div>
          {showDetailsRow ? (
            <div
              className="mt-1 mb-1 flex h-4 min-w-0 items-center gap-1.5 pr-1.5 pl-[var(--worktree-card-text-inset,24px)]"
              data-worktree-card-details-row=""
            >
              {presentation.hasMetaRow ? (
                <div className="min-w-0 flex-1">
                  <WorktreeCardMetaRow card={card} presentation={presentation} />
                </div>
              ) : null}
              {presentation.detailsAndPorts ? (
                <div className="ml-auto flex shrink-0 items-center gap-1">
                  {presentation.detailsAndPorts}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </WorktreeCardIdentityHover>
      <WorktreeCardSecondaryRows card={card} presentation={presentation} slotRows={slotRows} />
    </div>
  )
}
