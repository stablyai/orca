import { resolveAutoAckTabTargets } from './agent-auto-ack-targets'
export { resolveAutoAckTabTargets, type AutoAckTabTarget } from './agent-auto-ack-targets'
import { useEffect, useRef } from 'react'
import {
  createAutoAckPresenceCheck,
  subscribeAutoAckPresenceSignals
} from './agent-auto-ack-presence'
import { useAppStore } from '@/store'
import { isWebClientLocation } from '@/lib/web-client-location'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import { createTerminalAttentionSurface } from '@/components/terminal-pane/terminal-attention-surface'
import {
  applyAgentAttentionAcknowledgement,
  computeAgentAcknowledgementTargets,
  computeLapsedManualUnreadProtections,
  readAgentAttentionTurnStartedAt,
  resolveViewedUnreadSubjectKey,
  shouldClearWorkspaceAttention,
  type AgentAttentionTurnRecords
} from '@/attention/agent-attention-acknowledgement'

type StoreSnapshot = ReturnType<typeof useAppStore.getState>

/** Subject-keyed view of the store's turn bookkeeping for the neutral acknowledgement policy. */
function readTurnRecords(state: StoreSnapshot): AgentAttentionTurnRecords {
  return {
    liveTurns: state.agentStatusByPaneKey,
    retainedTurns: state.retainedAgentsByPaneKey,
    acknowledgedTurnStartedAt: state.acknowledgedAgentsByPaneKey
  }
}

// Auto-ack an agent row as "seen" when the user is already on its tab, so the dashboard/Dock don't stay bold for an event they watched happen.
// Scans live + retained maps: Codex's title-revert (pty-connection.ts:onAgentExited) migrates `done` rows to retained mid-race — see docs/codex-agent-row-bold-stuck.md.
export function useAutoAckViewedAgent(floatingPanelVisible: boolean): void {
  // Why a ref: the scan loop is mounted once, but panel visibility is React-local state that never
  // reaches the store, and re-subscribing on every open/close would drop the accumulated diff refs.
  const floatingPanelVisibleRef = useRef(floatingPanelVisible)
  const rescanRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    // Why: the store uses plain create() (no subscribeWithSelector), so manually track the slices we depend on to skip unrelated updates.
    // Init to undefined so the first maybeAck() (on mount) always passes the ref guard and scans.
    let lastActiveView: unknown = undefined
    let lastActiveTabId: unknown = undefined
    let lastFloatingWorkspaceActiveTabId: unknown = undefined
    let lastAgentStatus: unknown = undefined
    let lastRetained: unknown = undefined
    let lastAcknowledged: unknown = undefined
    let lastLayouts: unknown = undefined
    let lastUnreadAgentCompletionPanes: unknown = undefined

    // `force` re-scans after a signal the store never sees: panel open/closed is React-local state.
    const presence = createAutoAckPresenceCheck(
      async () => window.api?.notifications?.getDesktopAwayState?.(),
      () => maybeAck({ force: true, presenceConfirmed: true })
    )
    const maybeAck = (options?: { force?: boolean; presenceConfirmed?: boolean }): void => {
      const s = useAppStore.getState()
      const floatingWorkspaceActiveTabId =
        s.activeTabIdByWorktree[FLOATING_TERMINAL_WORKTREE_ID] ?? null
      if (
        !options?.force &&
        s.activeView === lastActiveView &&
        s.activeTabId === lastActiveTabId &&
        floatingWorkspaceActiveTabId === lastFloatingWorkspaceActiveTabId &&
        s.agentStatusByPaneKey === lastAgentStatus &&
        s.retainedAgentsByPaneKey === lastRetained &&
        s.acknowledgedAgentsByPaneKey === lastAcknowledged &&
        s.terminalLayoutsByTabId === lastLayouts &&
        s.unreadAgentCompletionPanes === lastUnreadAgentCompletionPanes
      ) {
        return
      }

      // Presence signals force a rescan; unrelated writes must not retry an away result.
      lastActiveView = s.activeView
      lastActiveTabId = s.activeTabId
      lastFloatingWorkspaceActiveTabId = floatingWorkspaceActiveTabId
      lastAgentStatus = s.agentStatusByPaneKey
      lastRetained = s.retainedAgentsByPaneKey
      lastAcknowledged = s.acknowledgedAgentsByPaneKey
      lastLayouts = s.terminalLayoutsByTabId
      lastUnreadAgentCompletionPanes = s.unreadAgentCompletionPanes

      // Why: tab-active only proxies "seen"; gate on window visible+focused so away-time transitions don't silently clear the bold signal.
      if (typeof document !== 'undefined') {
        if (document.visibilityState !== 'visible') {
          return
        }
        if (!document.hasFocus()) {
          return
        }
      }
      const targets = resolveAutoAckTabTargets(s, {
        floatingPanelVisible: floatingPanelVisibleRef.current
      })
      const surface = createTerminalAttentionSurface(s)
      // Why no protection reset here: zero targets just means nothing is on screen
      // (Settings, browser, an overlay) — a transient view switch must not lapse an
      // explicit mark-unread the user just made.
      if (targets.length === 0) {
        return
      }
      // Browsers have no native idle capability; their visible/focused gates still apply.
      if (!options?.presenceConfirmed && !isWebClientLocation()) {
        const records = readTurnRecords(s)
        const hasAttention = targets.some(({ tabId }) => {
          const subjectKey = surface.resolveViewedSubjectKey(tabId)
          return (
            computeAgentAcknowledgementTargets(records, subjectKey).length > 0 ||
            resolveViewedUnreadSubjectKey(s.unreadAgentCompletionPanes, subjectKey) !== null
          )
        })
        if (hasAttention) {
          presence.request()
          return
        }
      }

      const activeSubjectKeys = new Set<string>()
      for (const target of targets) {
        const subjectKey = surface.resolveViewedSubjectKey(target.tabId)
        if (subjectKey) {
          activeSubjectKeys.add(subjectKey)
        }
      }
      // Protection lapses when the user moves on to another subject or the agent takes a new
      // turn; a still-active subject with an unchanged turn keeps its explicit mark-unread.
      const lapsedProtections = computeLapsedManualUnreadProtections(
        {
          liveTurns: s.agentStatusByPaneKey,
          retainedTurns: s.retainedAgentsByPaneKey,
          manuallyUnreadTurnStartedAt: s.manuallyUnreadTurnsByPaneKey
        },
        activeSubjectKeys
      )
      if (lapsedProtections.length > 0) {
        s.clearManuallyUnreadTurns(lapsedProtections)
      }

      for (const target of targets) {
        // Why re-read: acking target[0] writes to the store, which re-enters this scan synchronously
        // and may already have handled target[1]; `s` is a pre-write snapshot that would re-ack it.
        const current = useAppStore.getState()
        const currentSurface = createTerminalAttentionSurface(current)
        const currentRecords = readTurnRecords(current)
        const groupId = target.tabId
        const subjectKey = currentSurface.resolveViewedSubjectKey(groupId)
        const toAck = computeAgentAcknowledgementTargets(currentRecords, subjectKey).filter(
          (key) =>
            current.manuallyUnreadTurnsByPaneKey[key] !==
            readAgentAttentionTurnStartedAt(currentRecords, key)
        )
        const viewedUnreadSubjectKey = resolveViewedUnreadSubjectKey(
          current.unreadAgentCompletionPanes,
          subjectKey
        )
        if (toAck.length > 0 || viewedUnreadSubjectKey) {
          const clearedSubjectKeys = new Set(toAck)
          if (viewedUnreadSubjectKey) {
            clearedSubjectKeys.add(viewedUnreadSubjectKey)
          }
          const workspaceId = target.worktreeId
          applyAgentAttentionAcknowledgement(
            {
              acknowledgeSubjects: current.acknowledgeAgents,
              clearWorkspaceUnread: current.clearWorktreeUnread,
              clearGroupUnread: current.clearTerminalTabUnread,
              clearSubjectUnread: current.clearTerminalPaneUnread
            },
            {
              workspaceIdToClear:
                workspaceId !== null &&
                shouldClearWorkspaceAttention(
                  currentSurface.collectWorkspaceAttentionRemainder(workspaceId),
                  { viewedGroupId: groupId, clearedSubjectKeys }
                )
                  ? workspaceId
                  : null,
              viewedGroupId: groupId,
              subjectKeys: toAck,
              viewedUnreadSubjectKey
            }
          )
        }
      }
    }
    rescanRef.current = (): void => maybeAck({ force: true })
    // Why: run once on mount to catch a restored session that already has agents on the visible tab.
    maybeAck()
    // Subscribe to all store changes; the ref-equality guard above skips unrelated updates.
    const unsubscribe = useAppStore.subscribe(() => maybeAck())
    const stopPresenceSignals = subscribeAutoAckPresenceSignals(
      () => maybeAck({ force: true }),
      () => maybeAck({ force: true, presenceConfirmed: true })
    )
    return () => {
      presence.dispose()
      rescanRef.current = null
      unsubscribe()
      stopPresenceSignals()
    }
  }, [])

  // Why forced: opening the panel puts an already-active floating tab on screen without any store
  // write, so the equality guard would skip the scan that clears its attention dot.
  useEffect(() => {
    floatingPanelVisibleRef.current = floatingPanelVisible
    if (floatingPanelVisible) {
      rescanRef.current?.()
    }
  }, [floatingPanelVisible])
}
