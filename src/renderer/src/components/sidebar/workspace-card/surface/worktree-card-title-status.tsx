import React, { createContext, useCallback, useContext, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'

import type { DashboardAgentRow } from '@/components/dashboard/rows/dashboard-agent-row'
import { useNow } from '@/hooks/use-now'
import { useAppStore } from '@/store'
import type { WorktreeStatus } from '../../../../../../shared/worktree-status-rollup'
import { lineageLaneStatus } from './worktree-card-lineage-lane-status'
import {
  composeWorktreeHostIdentity,
  type HostScopedWorktreeKey
} from '../../../../../../shared/worktree/host-qualified-identity'
import { selectAgentRowsUnread } from '../activity/worktree-card-agent-ack-inputs'
import { selectSendTargetControlInputs } from '../activity/worktree-card-send-target-inputs'
import { useWorktreeAgentExpansionState } from '../activity/worktree-card-agents-expansion-state'
import type { WorktreeCardController } from '../controller/use-worktree-card-controller'
import { collectLineageSlotTargets, useLineageSlotSummary } from '../../worktree-card-slot-rollup'
import {
  buildSlotAgentSignals,
  type SlotAgentSignals
} from '../../worktree-card-slot-agent-signals'
import { titleRowSlot, titleRowUnread, type SlotException } from '../../worktree-card-slot-signal'
import {
  expandWorkspaceUnreadTargets,
  slotTargetsFromAgentLines,
  slotTargetsOfKind,
  workspaceUnreadTarget,
  workspaceUnreadTargetsOutsideAgentRows,
  type SlotTarget
} from '../../worktree-card-slot-targets'
import { createWorkspaceUnreadSelector } from './worktree-card-workspace-unread-selector'
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
  /** Dot and bold: any unread the card holds, including a visible agent line's. */
  unread: boolean
  /** The lane status collapsed descendants claim (needs you, failed, working); null when quiet. */
  lineageStatus: WorktreeStatus | null
  at: number | null
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
  const agents = card.inlineAgentRows
  const signals = useSlotAgentSignals(agents)
  const offline = card.isRuntimeDisconnected || card.isSshDisconnected
  const identity = composeWorktreeHostIdentity(worktree.hostId ?? 'local', worktree.id)
  const markedByUser = useAppStore((s) => Boolean(s.workspacesMarkedUnreadByUser[identity]))
  const pickingSendTarget = useAppStore(
    (s) => selectSendTargetControlInputs(s, worktree.id).targetMode !== null
  )
  const { compactRootListExpanded } = useWorktreeAgentExpansionState(worktree.id, worktree.hostId)
  // Compact mode folds two or more agents behind a summary row until it is expanded.
  const foldedBehindSummary =
    card.agentActivityDisplayMode === 'compact' &&
    signals.rootCount > 1 &&
    !compactRootListExpanded &&
    !pickingSendTarget
  const linesShown = showInlineAgentList && signals.rootCount > 0 && !foldedBehindSummary
  const descendants = lineageDescendantIdentities ?? NO_DESCENDANTS
  const hiddenDescendants = lineageCollapsed ? descendants : NO_DESCENDANTS
  const lineage = useLineageSlotSummary(descendants, lineageCollapsed)
  const collapsedLineage = lineage.exceptions
  const lastActivityAt = worktree.lastActivityAt > 0 ? worktree.lastActivityAt : null
  const visibleAgentTargets = useMemo(
    () => (linesShown ? slotTargetsFromAgentLines(worktree.id, signals, worktree.hostId) : []),
    [linesShown, signals, worktree.hostId, worktree.id]
  )
  const selectWorkspaceUnread = useMemo(
    () => createWorkspaceUnreadSelector(worktree, visibleAgentTargets),
    [visibleAgentTargets, worktree]
  )
  const workspaceUnread = useAppStore(selectWorkspaceUnread)
  const slot = titleRowSlot({
    offline,
    lines: signals.allSignals,
    collapsedLineage,
    workspaceUnread: workspaceUnread ? { manual: markedByUser } : null,
    ownLinesShown: linesShown,
    lastActivityAt,
    lineageLatestAt: lineage.latestAt
  })
  const resolveTargets = useCallback(
    (kind: SlotException['kind']) => {
      const state = useAppStore.getState()
      return slotTargetsOfKind(
        [
          ...expandWorkspaceUnreadTargets(state, [
            ...(linesShown ? [] : slotTargetsFromAgentLines(worktree.id, signals, worktree.hostId)),
            ...collectLineageSlotTargets(state, hiddenDescendants)
          ]),
          ...(workspaceUnread
            ? workspaceUnreadTargetsOutsideAgentRows(
                state,
                workspaceUnreadTarget(worktree.id, lastActivityAt, worktree.hostId),
                visibleAgentTargets
              )
            : [])
        ],
        kind
      )
    },
    [
      hiddenDescendants,
      lastActivityAt,
      linesShown,
      signals,
      visibleAgentTargets,
      workspaceUnread,
      worktree.hostId,
      worktree.id
    ]
  )
  const exceptions = slot.kind === 'status' ? slot.exceptions : NO_EXCEPTIONS
  const at = slot.kind === 'status' ? slot.at : null
  // Why: a collapsed parent rolls up its children's unread agent lines, so each child must show
  // the same dot even when the line is visible, or expanding hides where the unread came from.
  const unread = titleRowUnread({ lines: signals.allSignals, collapsedLineage, workspaceUnread })
  const lineageStatus = lineageLaneStatus(collapsedLineage)
  const value = useMemo<TitleStatus>(
    () => ({ offline, exceptions, unread, lineageStatus, at, resolveTargets }),
    [at, exceptions, lineageStatus, offline, resolveTargets, unread]
  )
  return <TitleStatusContext.Provider value={value}>{children}</TitleStatusContext.Provider>
}

/** True while the card holds an unread result: its own, any of its agents' or a collapsed child's. */
export function useWorktreeCardRolledUpUnread(): boolean {
  return useContext(TitleStatusContext)?.unread === true
}

/** What collapsed child workspaces claim for the lane, so a running child shows on its parent. */
export function useWorktreeCardLineageLaneStatus(): WorktreeStatus | null {
  return useContext(TitleStatusContext)?.lineageStatus ?? null
}

/** The title row's right edge: a pill per loud status the card speaks for, then the time. */
export function WorktreeCardTitleStatus(): React.JSX.Element | null {
  const status = useContext(TitleStatusContext)
  const now = useNow(30_000)
  if (!status) {
    return null
  }
  if (status.offline) {
    return <WorktreeCardSlot signal={{ kind: 'offline' }} now={now} />
  }
  return (
    <>
      <WorktreeCardTitlePills
        exceptions={status.exceptions}
        resolveTargets={status.resolveTargets}
      />
      <WorktreeCardTitleTime exceptions={status.exceptions} at={status.at} now={now} />
    </>
  )
}
