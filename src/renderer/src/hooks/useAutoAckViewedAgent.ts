import { useEffect, useRef } from 'react'
import { useAppStore } from '@/store'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import { makePaneKey } from '../../../shared/stable-pane-id'
import {
  acknowledgeViewedAgentAttention,
  computeAutoAckTargets,
  computeLapsedManualUnreadProtections,
  computeViewedAgentCompletionPaneKey,
  getAgentTurnTimestamp,
  resolveActiveLeafId,
  resolveAutoAckTabTargets,
  shouldClearViewedAgentWorktreeUnread
} from './viewed-agent-attention-targets'

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
    let lastActiveSessionGridTabId: unknown = undefined
    let lastFloatingWorkspaceActiveTabId: unknown = undefined
    let lastAgentStatus: unknown = undefined
    let lastRetained: unknown = undefined
    let lastAcknowledged: unknown = undefined
    let lastLayouts: unknown = undefined
    let lastUnreadAgentCompletionPanes: unknown = undefined
    let lastUnreadTerminalTabs: unknown = undefined

    // `force` re-scans after a signal the store never sees: panel open/closed is React-local state.
    const maybeAck = (options?: { force?: boolean }): void => {
      const s = useAppStore.getState()
      const floatingWorkspaceActiveTabId =
        s.activeTabIdByWorktree[FLOATING_TERMINAL_WORKTREE_ID] ?? null
      if (
        !options?.force &&
        s.activeView === lastActiveView &&
        s.activeTabId === lastActiveTabId &&
        // Why its own ref: selecting another grid card moves nothing else in the store,
        // so without this the scan would skip the very transition that means "I'm looking".
        s.activeSessionGridTabId === lastActiveSessionGridTabId &&
        floatingWorkspaceActiveTabId === lastFloatingWorkspaceActiveTabId &&
        s.agentStatusByPaneKey === lastAgentStatus &&
        s.retainedAgentsByPaneKey === lastRetained &&
        s.acknowledgedAgentsByPaneKey === lastAcknowledged &&
        s.terminalLayoutsByTabId === lastLayouts &&
        s.unreadAgentCompletionPanes === lastUnreadAgentCompletionPanes &&
        // Why this one too, and not just the completion panes: a parked pane's BEL writes
        // ONLY `markTerminalTabUnread` (parked-terminal-byte-watcher's onBell), and a grid
        // card is exactly the parked case — it mounts a preview, not a pane. Without this
        // ref the bell lights on the card you already have selected and no click can put it
        // out, because nothing the guard watches ever moved.
        s.unreadTerminalTabs === lastUnreadTerminalTabs
      ) {
        return
      }

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
      // Why no protection reset here: zero targets just means nothing is on screen
      // (Settings, browser, an overlay) — a transient view switch must not lapse an
      // explicit mark-unread the user just made.
      if (targets.length === 0) {
        return
      }
      // Why: advance refs only after gates pass, else the diff is consumed and a gated-out transition never re-acks when focus returns.
      lastActiveView = s.activeView
      lastActiveTabId = s.activeTabId
      lastActiveSessionGridTabId = s.activeSessionGridTabId
      lastFloatingWorkspaceActiveTabId = floatingWorkspaceActiveTabId
      lastAgentStatus = s.agentStatusByPaneKey
      lastRetained = s.retainedAgentsByPaneKey
      lastAcknowledged = s.acknowledgedAgentsByPaneKey
      lastLayouts = s.terminalLayoutsByTabId
      lastUnreadAgentCompletionPanes = s.unreadAgentCompletionPanes
      lastUnreadTerminalTabs = s.unreadTerminalTabs

      const activePaneKeys = new Set<string>()
      for (const target of targets) {
        const activeLeafId = resolveActiveLeafId(s, target.tabId)
        if (activeLeafId) {
          activePaneKeys.add(makePaneKey(target.tabId, activeLeafId))
        }
      }
      // Protection lapses when the user moves on to another pane or the agent takes a new
      // turn; a still-active pane with an unchanged turn keeps its explicit mark-unread.
      const lapsedProtections = computeLapsedManualUnreadProtections(s, activePaneKeys)
      if (lapsedProtections.length > 0) {
        s.clearManuallyUnreadTurns(lapsedProtections)
      }

      for (const target of targets) {
        // Why re-read: acking target[0] writes to the store, which re-enters this scan synchronously
        // and may already have handled target[1]; `s` is a pre-write snapshot that would re-ack it.
        const current = useAppStore.getState()
        const tabId = target.tabId
        const activeLeafId = resolveActiveLeafId(current, tabId)
        const toAck = computeAutoAckTargets(current, tabId, activeLeafId).filter(
          (paneKey) =>
            current.manuallyUnreadTurnsByPaneKey[paneKey] !==
            getAgentTurnTimestamp(current, paneKey)
        )
        const activePaneKey = computeViewedAgentCompletionPaneKey(current, tabId, activeLeafId)
        const hasTabUnread = current.unreadTerminalTabs[tabId] === true
        if (toAck.length > 0 || activePaneKey || hasTabUnread) {
          const paneKeysToClear = new Set(toAck)
          if (activePaneKey) {
            paneKeysToClear.add(activePaneKey)
          }
          const worktreeId = target.worktreeId
          acknowledgeViewedAgentAttention(current, {
            activeWorktreeId: shouldClearViewedAgentWorktreeUnread(current, {
              activeWorktreeId: worktreeId,
              activeTabId: tabId,
              paneKeysToClear
            })
              ? worktreeId
              : null,
            activeTabId: tabId,
            paneKeys: toAck,
            activePaneKey,
            hasTabUnread
          })
        }
      }
    }
    rescanRef.current = (): void => maybeAck({ force: true })
    // Why: run once on mount to catch a restored session that already has agents on the visible tab.
    maybeAck()
    // Subscribe to all store changes; the ref-equality guard above skips unrelated updates.
    const unsubscribe = useAppStore.subscribe(() => maybeAck())
    // Why: focus/visibility don't flow through zustand, so re-run the scan on these DOM events when focus returns.
    const onVisibility = (): void => maybeAck()
    const onFocus = (): void => maybeAck()
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('focus', onFocus)
    return () => {
      rescanRef.current = null
      unsubscribe()
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('focus', onFocus)
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
