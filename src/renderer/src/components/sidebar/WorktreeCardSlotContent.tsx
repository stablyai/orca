import React, { useCallback, useMemo } from 'react'
import { ChevronRight } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'

import type { DashboardAgentRow } from '@/components/dashboard/useDashboardData'
import type { HostScopedWorktreeKey } from '../../../../shared/worktree/host-qualified-identity'
import { useNow } from '@/hooks/use-now'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { canConnectSshStatus, isConnectingSshStatus } from '@/ssh/ssh-connection-recoverability'
import { useAppStore } from '@/store'
import { workspaceHasLiveMarker } from '@/store/slices/workspace-attention/workspace-live-markers'
import type { WorktreeCardController } from './workspace-card/controller/use-worktree-card-controller'
import { useWorktreeAgentRows } from './workspace-card/activity/useWorktreeAgentRows'
import { selectAgentRowsUnread } from './workspace-card/activity/worktree-card-agent-ack-inputs'
import { selectSendTargetControlInputs } from './workspace-card/activity/worktree-card-send-target-inputs'
import { useWorktreeAgentExpansionState } from './workspace-card/activity/worktree-card-agents-expansion-state'
import {
  CompactAgentExpansion,
  CompactAgentSummaryButton
} from './workspace-card/activity/worktree-card-compact-agents'
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
import { WorktreeCardSlot, WorktreeCardTitleSlot } from './WorktreeCardSlot'
import {
  slotTargetsFromAgentLines,
  slotTargetsOfKind,
  workspaceUnreadTarget
} from './worktree-card-slot-targets'
import { SlotAgentLinesHeader, WorktreeCardSlotAgentLines } from './WorktreeCardSlotAgentLines'
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
  const agents = useWorktreeAgentRows(worktree.id)
  const signals = useSlotAgentSignals(agents)
  const lines = signals.rootLines
  const now = useNow(30_000)
  const host = getWorktreeCardHost(card)
  const sshDown = host?.kind === 'ssh' && host.down
  const offline = isRuntimeDisconnected || sshDown
  const hasLiveMarker = useAppStore((s) => workspaceHasLiveMarker(s, worktree.id))
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
  // Several agents fold into the 1.0 summary row; the title slot speaks for them until expanded.
  const { compactRootListExpanded: agentsExpanded, toggleCompactRootList } =
    useWorktreeAgentExpansionState(worktree.id)
  const toggleAgents = useCallback(() => {
    dispatchSuppressScrollAdjustment()
    toggleCompactRootList()
  }, [toggleCompactRootList])
  const hasLines = showInlineAgentList && lines.length > 0
  const canOpen = hasLines || showLineageChildChip
  const showLines = open && hasLines
  const foldsAgents = showLines && lines.length > 1 && !pickingSendTarget
  const ownLinesShown = showLines && (!foldsAgents || agentsExpanded)
  const agentUnread = signals.allSignals.some((signal) => signal.kind === 'unread')
  // Any unread source counts (a terminal tab, a pane, the user's mark) unless a visible line already shows it.
  const workspaceUnread =
    worktree.isUnread && !(ownLinesShown && agentUnread) ? { manual: !hasLiveMarker } : null
  const titleSlot = titleRowSlot({
    offline,
    lines: signals.allSignals,
    collapsedLineage,
    workspaceUnread,
    ownLinesShown,
    lastActivityAt: worktree.lastActivityAt > 0 ? worktree.lastActivityAt : null,
    lineageLatestAt
  })
  const worktreeLastActivityAt = worktree.lastActivityAt > 0 ? worktree.lastActivityAt : null
  // Only what the title row speaks for: hidden agent lines, collapsed children, the workspace's own mark.
  const workspaceUnreadShown = workspaceUnread !== null
  const resolveTitleTargets = useCallback(
    (kind: SlotException['kind']) =>
      slotTargetsOfKind(
        [
          ...(ownLinesShown ? [] : slotTargetsFromAgentLines(worktree.id, signals)),
          ...(lineageHidden ? collectLineageSlotTargets(useAppStore.getState(), descendants) : []),
          ...(workspaceUnreadShown
            ? [workspaceUnreadTarget(worktree.id, worktreeLastActivityAt)]
            : [])
        ],
        kind
      ),
    [
      descendants,
      lineageHidden,
      ownLinesShown,
      signals,
      workspaceUnreadShown,
      worktree.id,
      worktreeLastActivityAt
    ]
  )
  const showDetailsRow =
    settings?.worktreeCardDetailsRow === true &&
    (presentation.hasMetaRow || presentation.detailsAndPorts !== null)
  const titleBold = worktree.isUnread || agentUnread

  const agentLines = showLines ? (
    <WorktreeCardSlotAgentLines
      worktreeId={worktree.id}
      agents={agents}
      signals={signals}
      now={now}
      offline={offline}
      cacheTimersActive={ownLinesShown}
    />
  ) : null

  const agentCountLabel = translate('sidebar.agentSummary.agentCount', '{{count}} agents', {
    count: lines.length,
    defaultValue_one: '{{count}} agent'
  })
  const slotRows = (
    <>
      {foldsAgents ? (
        <>
          {agentsExpanded ? (
            <div className="pl-2.5">
              <SlotAgentLinesHeader label={agentCountLabel} onCollapse={toggleAgents} />
            </div>
          ) : (
            <div className="mt-[3px] min-w-0 pr-1.5 pl-3.5">
              <CompactAgentSummaryButton
                agents={lines.map((line) => line.agent)}
                subjectLabel={agentCountLabel}
                expanded={false}
                onToggle={toggleAgents}
              />
            </div>
          )}
          <CompactAgentExpansion expanded={agentsExpanded}>{agentLines}</CompactAgentExpansion>
        </>
      ) : (
        agentLines
      )}
      {open && showLineageChildChip ? (
        <div className="mt-[3px] flex min-w-0 pr-1.5 pl-3.5">
          <WorktreeCardChildrenChip
            childIdentities={lineageChildIdentities}
            collapsed={lineageCollapsed}
            label={childWorkspaceShortLabel}
            ariaLabel={lineageChildAriaLabel}
            onToggle={onLineageToggle}
          />
        </div>
      ) : null}
    </>
  )

  const openToggleLabel = open
    ? translate('sidebar.cardSlot.closeCard', 'Hide workspace activity')
    : translate('sidebar.cardSlot.openCard', 'Show workspace activity')
  // The line ties everything below the title to this card; a lone title row has nothing to tie.
  const showThread = showDetailsRow || (open && canOpen)

  return (
    <div
      className={cn(
        'flex w-full min-w-0 flex-col overflow-hidden',
        showThread && 'worktree-card-slot-thread'
      )}
      data-worktree-card-open={open || undefined}
      data-worktree-card-parent-content=""
      data-worktree-card-style="experimental-2"
    >
      <WorktreeCardIdentityHover card={card} presentation={presentation}>
        <div
          className="group/worktree-card flex min-w-0 flex-col"
          data-worktree-card-hover-trigger=""
        >
          <div className="flex h-5 min-w-0 items-center gap-1.5 pr-1.5">
            <WorktreeTitleInlineRename
              displayName={visibleCardTitle}
              disabled={isDeleting || affiliateListMode}
              showUnreadEmphasis={titleBold}
              dimReadTitle
              className="text-[13px] leading-5"
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
              {sshDown && host ? (
                <SshHostSlot card={card} label={host.label} />
              ) : titleSlot.kind === 'offline' ? (
                <WorktreeCardSlot signal={titleSlot} now={now} />
              ) : (
                <WorktreeCardTitleSlot
                  exceptions={titleSlot.exceptions}
                  at={titleSlot.at}
                  now={now}
                  resolveTargets={resolveTitleTargets}
                />
              )}
              {canOpen ? (
                <button
                  type="button"
                  className={cn(
                    '-mr-0.5 inline-flex size-3.5 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-opacity hover:text-foreground focus-visible:opacity-100 disabled:pointer-events-none',
                    open
                      ? 'opacity-100'
                      : 'opacity-0 can-hover:group-hover/worktree-card:opacity-100'
                  )}
                  aria-label={openToggleLabel}
                  aria-expanded={open}
                  disabled={pickingSendTarget}
                  onPointerDown={card.stopQuickActionPointerPropagation}
                  onClick={(event) => {
                    event.stopPropagation()
                    dispatchSuppressScrollAdjustment()
                    onToggleOpen()
                  }}
                >
                  <ChevronRight
                    className={cn(
                      'size-3 transition-transform motion-reduce:transition-none',
                      open && 'rotate-90'
                    )}
                    aria-hidden
                  />
                </button>
              ) : null}
            </span>
          </div>
          {showDetailsRow ? (
            <div
              className="mt-1 mb-1 flex h-4 min-w-0 items-center gap-1.5 pr-1.5 pl-3.5"
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
