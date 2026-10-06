import { resolveAutoAckTabTargets } from './agent-auto-ack-targets'
export { resolveAutoAckTabTargets, type AutoAckTabTarget } from './agent-auto-ack-targets'
import { useEffect } from 'react'
import {
  createAutoAckPresenceCheck,
  subscribeAutoAckPresenceSignals
} from './agent-auto-ack-presence'
import { useAppStore } from '@/store'
import { selectFloatingWorkspacePanelVisible } from '@/store/floating-workspace-panel-selector'
import { isWebClientLocation } from '@/lib/web-client-location'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import {
  acknowledgeViewedAutoAckTarget,
  readAgentAttentionTurnRecords,
  surfaceForAutoAckTarget
} from './agent-auto-ack-surfaces'
import {
  computeAgentAcknowledgementTargets,
  computeLapsedManualUnreadProtections,
  resolveViewedUnreadSubjectKey
} from '@/attention/agent-attention-acknowledgement'

// Auto-ack an agent row as "seen" when the user is already on its tab, so the dashboard/Dock don't stay bold for an event they watched happen.
// Scans live + retained maps: Codex's title-revert (pty-connection.ts:onAgentExited) migrates `done` rows to retained mid-race — see docs/codex-agent-row-bold-stuck.md.
export function useAutoAckViewedAgent(): void {
  useEffect(() => {
    // Why: the store uses plain create() (no subscribeWithSelector), so manually track the slices we depend on to skip unrelated updates.
    // Init to undefined so the first maybeAck() (on mount) always passes the ref guard and scans.
    let lastActiveView: unknown = undefined
    let lastActiveTabId: unknown = undefined
    let lastActiveWorktreeId: unknown = undefined
    let lastActiveWorkspaceGroupId: unknown = undefined
    let lastActiveWorkspaceGroups: unknown = undefined
    let lastFloatingWorkspaceActiveTabId: unknown = undefined
    let lastFloatingWorkspaceGroupId: unknown = undefined
    let lastFloatingWorkspaceGroups: unknown = undefined
    let lastAgentStatus: unknown = undefined
    let lastRetained: unknown = undefined
    let lastAcknowledged: unknown = undefined
    let lastLayouts: unknown = undefined
    let lastUnreadAgentCompletionPanes: unknown = undefined
    let lastFloatingPanelVisible = false

    // `force` re-scans after a presence signal the store never sees.
    const presence = createAutoAckPresenceCheck(
      async () => window.api?.notifications?.getDesktopAwayState?.(),
      () => maybeAck({ force: true, presenceConfirmed: true })
    )
    const maybeAck = (options?: { force?: boolean; presenceConfirmed?: boolean }): void => {
      const s = useAppStore.getState()
      const activeWorktreeId = s.activeWorktreeId
      const activeWorkspaceGroupId = activeWorktreeId
        ? (s.activeGroupIdByWorktree[activeWorktreeId] ?? null)
        : null
      const activeWorkspaceGroups = activeWorktreeId
        ? s.groupsByWorktree[activeWorktreeId]
        : undefined
      const floatingWorkspaceActiveTabId =
        s.activeTabIdByWorktree[FLOATING_TERMINAL_WORKTREE_ID] ?? null
      const floatingWorkspaceGroupId =
        s.activeGroupIdByWorktree[FLOATING_TERMINAL_WORKTREE_ID] ?? null
      const floatingWorkspaceGroups = s.groupsByWorktree[FLOATING_TERMINAL_WORKTREE_ID]
      // Why only the opening edge: opening puts an already-active floating tab on screen, so it
      // must scan; closing must not, or it would lapse a mark-unread on the tab the user left.
      const floatingPanelVisible = selectFloatingWorkspacePanelVisible(s)
      const floatingPanelOpened = floatingPanelVisible && !lastFloatingPanelVisible
      lastFloatingPanelVisible = floatingPanelVisible
      if (
        !options?.force &&
        !floatingPanelOpened &&
        s.activeView === lastActiveView &&
        s.activeTabId === lastActiveTabId &&
        activeWorktreeId === lastActiveWorktreeId &&
        activeWorkspaceGroupId === lastActiveWorkspaceGroupId &&
        activeWorkspaceGroups === lastActiveWorkspaceGroups &&
        floatingWorkspaceActiveTabId === lastFloatingWorkspaceActiveTabId &&
        floatingWorkspaceGroupId === lastFloatingWorkspaceGroupId &&
        floatingWorkspaceGroups === lastFloatingWorkspaceGroups &&
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
      lastActiveWorktreeId = activeWorktreeId
      lastActiveWorkspaceGroupId = activeWorkspaceGroupId
      lastActiveWorkspaceGroups = activeWorkspaceGroups
      lastFloatingWorkspaceActiveTabId = floatingWorkspaceActiveTabId
      lastFloatingWorkspaceGroupId = floatingWorkspaceGroupId
      lastFloatingWorkspaceGroups = floatingWorkspaceGroups
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
      const targets = resolveAutoAckTabTargets(s)
      // Why no protection reset here: zero targets just means nothing is on screen
      // (Settings, browser, an overlay) — a transient view switch must not lapse an
      // explicit mark-unread the user just made.
      if (targets.length === 0) {
        return
      }
      // Browsers have no native idle capability; their visible/focused gates still apply.
      if (!options?.presenceConfirmed && !isWebClientLocation()) {
        const records = readAgentAttentionTurnRecords(s)
        const hasAttention = targets.some((target) => {
          const subjectKey = surfaceForAutoAckTarget(s, target).resolveViewedSubjectKey(
            target.tabId
          )
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
        const subjectKey = surfaceForAutoAckTarget(s, target).resolveViewedSubjectKey(target.tabId)
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
        acknowledgeViewedAutoAckTarget(useAppStore.getState(), target)
      }
    }
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
      unsubscribe()
      stopPresenceSignals()
    }
  }, [])
}
