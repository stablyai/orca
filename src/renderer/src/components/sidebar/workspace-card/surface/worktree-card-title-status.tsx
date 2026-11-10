import React, { createContext, useCallback, useContext, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'

import type { DashboardAgentRow } from '@/components/dashboard/useDashboardData'
import { useNow } from '@/hooks/use-now'
import { useAppStore } from '@/store'
import type { HostScopedWorktreeKey } from '../../../../../../shared/worktree/host-qualified-identity'
import { selectAgentRowsUnread } from '../activity/worktree-card-agent-ack-inputs'
import { selectSendTargetControlInputs } from '../activity/worktree-card-send-target-inputs'
import { useWorktreeAgentExpansionState } from '../activity/worktree-card-agents-expansion-state'
import { useWorktreeAgentRows } from '../activity/useWorktreeAgentRows'
import type { WorktreeCardController } from '../controller/use-worktree-card-controller'
import { getWorktreeCardHost } from '../../worktree-card-host-name'
import {
  collectLineageSlotTargets,
  useCollapsedLineageSlots,
  useLineageLatestAt
} from '../../worktree-card-slot-rollup'
import {
  buildSlotAgentSignals,
  type SlotAgentSignals
} from '../../worktree-card-slot-agent-signals'
import { titleRowSlot, type SlotException } from '../../worktree-card-slot-signal'
import {
  expandWorkspaceUnreadTargets,
  slotTargetsFromAgentLines,
  slotTargetsOfKind,
  workspaceUnreadTarget,
  type SlotTarget
} from '../../worktree-card-slot-targets'
import {
  WorktreeCardSlot,
  WorktreeCardTitlePills,
  WorktreeCardTitleTime
} from '../../WorktreeCardSlot'

const NO_DESCENDANTS: readonly HostScopedWorktreeKey[] = []
const NO_EXCEPTIONS: readonly SlotException[] = []

type TitleStatus = {
  offline: boolean
  /** What the title speaks for: hidden agents, collapsed child workspaces, the workspace's own unread. */
  exceptions: readonly SlotException[]
  at: number | null
  now: number
  resolveTargets: (kind: SlotException['kind']) => SlotTarget[]
}

const TitleStatusContext = createContext<TitleStatus | null>(null)

function useSlotAgentSignals(agents: DashboardAgentRow[]): SlotAgentSignals {
  // Same acknowledgement records the agent rows read, so unread means the same in both places.
  const unread = useAppStore(useShallow((s) => selectAgentRowsUnread(s, agents)))
  return useMemo(() => buildSlotAgentSignals(agents, unread), [agents, unread])
}

/**
 * Computes the card's rolled-up status once, for the status lane, the title and the title's
 * right-hand slot: rows mount by the hundreds, so the three must not each subscribe.
 */
export function WorktreeCardTitleStatusProvider({
  card,
  children
}: {
  card: WorktreeCardController
  children: React.ReactNode
}): React.JSX.Element {
  const { worktree, showInlineAgentList, lineageCollapsed, lineageDescendantIdentities } = card
  const agents = useWorktreeAgentRows(worktree.id, true, worktree.hostId)
  const signals = useSlotAgentSignals(agents)
  const now = useNow(30_000)
  const host = getWorktreeCardHost(card)
  const offline = card.isRuntimeDisconnected || (host?.kind === 'ssh' && host.down)
  const markedByUser = useAppStore((s) => Boolean(s.workspacesMarkedUnreadByUser[worktree.id]))
  const pickingSendTarget = useAppStore(
    (s) => selectSendTargetControlInputs(s, worktree.id).targetMode !== null
  )
  const { compactRootListExpanded } = useWorktreeAgentExpansionState(worktree.id)
  // Compact mode folds two or more agents behind a summary row until it is expanded.
  const foldedBehindSummary =
    card.agentActivityDisplayMode === 'compact' &&
    signals.rootLines.length > 1 &&
    !compactRootListExpanded &&
    !pickingSendTarget
  const linesShown = showInlineAgentList && signals.rootLines.length > 0 && !foldedBehindSummary
  const descendants = lineageDescendantIdentities ?? NO_DESCENDANTS
  const hiddenDescendants = lineageCollapsed ? descendants : NO_DESCENDANTS
  const collapsedLineage = useCollapsedLineageSlots(hiddenDescendants)
  const lineageLatestAt = useLineageLatestAt(descendants)
  const agentUnread = signals.allSignals.some((signal) => signal.kind === 'unread')
  // Any unread source counts (a terminal tab, a pane, the user's mark) unless a visible row already shows it.
  const workspaceUnread = worktree.isUnread && !(linesShown && agentUnread)
  const lastActivityAt = worktree.lastActivityAt > 0 ? worktree.lastActivityAt : null
  const slot = titleRowSlot({
    offline,
    lines: signals.allSignals,
    collapsedLineage,
    workspaceUnread: workspaceUnread ? { manual: markedByUser } : null,
    ownLinesShown: linesShown,
    lastActivityAt,
    lineageLatestAt
  })
  const resolveTargets = useCallback(
    (kind: SlotException['kind']) => {
      const state = useAppStore.getState()
      return slotTargetsOfKind(
        expandWorkspaceUnreadTargets(state, [
          ...(linesShown ? [] : slotTargetsFromAgentLines(worktree.id, signals, worktree.hostId)),
          ...collectLineageSlotTargets(state, hiddenDescendants),
          ...(workspaceUnread
            ? [workspaceUnreadTarget(worktree.id, lastActivityAt, worktree.hostId)]
            : [])
        ]),
        kind
      )
    },
    [
      hiddenDescendants,
      lastActivityAt,
      linesShown,
      signals,
      workspaceUnread,
      worktree.hostId,
      worktree.id
    ]
  )
  const exceptions = slot.kind === 'status' ? slot.exceptions : NO_EXCEPTIONS
  const at = slot.kind === 'status' ? slot.at : null
  const value = useMemo<TitleStatus>(
    () => ({ offline, exceptions, at, now, resolveTargets }),
    [at, exceptions, now, offline, resolveTargets]
  )
  return <TitleStatusContext.Provider value={value}>{children}</TitleStatusContext.Provider>
}

/** True while the card speaks for an unread result: its own, a folded agent's or a collapsed child's. */
export function useWorktreeCardRolledUpUnread(): boolean {
  const status = useContext(TitleStatusContext)
  return status?.exceptions.some((exception) => exception.kind === 'unread') === true
}

/** The title row's right edge: a pill per loud status the card speaks for, then the time. */
export function WorktreeCardTitleStatus(): React.JSX.Element | null {
  const status = useContext(TitleStatusContext)
  if (!status) {
    return null
  }
  if (status.offline) {
    return <WorktreeCardSlot signal={{ kind: 'offline' }} now={status.now} />
  }
  return (
    <>
      <WorktreeCardTitlePills
        exceptions={status.exceptions}
        resolveTargets={status.resolveTargets}
      />
      <WorktreeCardTitleTime
        exceptions={status.exceptions}
        at={status.at}
        now={status.now}
        toggle={null}
      />
    </>
  )
}
