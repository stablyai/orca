import { useEffect, useRef } from 'react'
import { useAppStore } from '@/store'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import type { RetainedAgentEntry } from '@/store/slices/agent-status'
import type { TerminalLayoutSnapshot } from '../../../shared/terminal-tab-types'
import { isTerminalLeafId, makePaneKey, parsePaneKey } from '../../../shared/stable-pane-id'

function resolveActiveLeafId(
  state: { terminalLayoutsByTabId: Record<string, TerminalLayoutSnapshot> },
  activeTabId: string
): string | null {
  const leafId = state.terminalLayoutsByTabId[activeTabId]?.activeLeafId ?? null
  return leafId && isTerminalLeafId(leafId) ? leafId : null
}

/**
 * Returns paneKeys to ack for the active tab/leaf; exported for the
 * codex-row-bold regression test (docs/codex-agent-row-bold-stuck.md).
 *
 * Why: split tabs host multiple agent panes, so match exact `${tabId}:${leafId}` — a tab-prefix match would ack undisplayed siblings.
 */
export function computeAutoAckTargets(
  state: {
    agentStatusByPaneKey: Record<string, AgentStatusEntry>
    retainedAgentsByPaneKey: Record<string, RetainedAgentEntry>
    acknowledgedAgentsByPaneKey: Record<string, number>
  },
  activeTabId: string,
  activeLeafId: string | null
): string[] {
  if (!activeLeafId || !isTerminalLeafId(activeLeafId)) {
    return []
  }
  const targetKey = makePaneKey(activeTabId, activeLeafId)
  const targets: string[] = []
  const liveEntry = state.agentStatusByPaneKey[targetKey]
  if (liveEntry) {
    const ackAt = state.acknowledgedAgentsByPaneKey[targetKey] ?? 0
    // Why: compare stateStartedAt (not updatedAt) so same-state pings don't re-trigger ack, matching WorktreeCardAgents' is-unvisited rule.
    if (ackAt < liveEntry.stateStartedAt) {
      targets.push(targetKey)
    }
  }
  const retained = state.retainedAgentsByPaneKey[targetKey]
  if (retained) {
    const ackAt = state.acknowledgedAgentsByPaneKey[targetKey] ?? 0
    if (ackAt < retained.entry.stateStartedAt) {
      targets.push(targetKey)
    }
  }
  return targets
}

export function computeViewedAgentCompletionPaneKey(
  state: {
    unreadAgentCompletionPanes: Record<string, true>
  },
  activeTabId: string,
  activeLeafId: string | null
): string | null {
  if (!activeLeafId || !isTerminalLeafId(activeLeafId)) {
    return null
  }

  const targetKey = makePaneKey(activeTabId, activeLeafId)
  return state.unreadAgentCompletionPanes[targetKey] ? targetKey : null
}

export function shouldClearViewedAgentWorktreeUnread(
  state: {
    tabsByWorktree: Record<string, { id: string }[]>
    unreadAgentCompletionPanes: Record<string, true>
    unreadTerminalTabs: Record<string, true>
  },
  args: {
    activeWorktreeId: string | null
    activeTabId: string
    paneKeysToClear: Set<string>
  }
): boolean {
  if (!args.activeWorktreeId) {
    return false
  }

  const tabIds = new Set((state.tabsByWorktree[args.activeWorktreeId] ?? []).map((tab) => tab.id))
  if (tabIds.size === 0) {
    return true
  }

  // Why: worktree unread is coarse — don't clear for the visible pane if a hidden tab/pane in the same worktree still owns unread attention.
  for (const paneKey of Object.keys(state.unreadAgentCompletionPanes)) {
    if (args.paneKeysToClear.has(paneKey)) {
      continue
    }
    const parsed = parsePaneKey(paneKey)
    if (parsed && tabIds.has(parsed.tabId)) {
      return false
    }
  }

  for (const tabId of Object.keys(state.unreadTerminalTabs)) {
    if (tabId !== args.activeTabId && tabIds.has(tabId)) {
      return false
    }
  }

  return true
}

type ViewedAgentAttentionActions = {
  acknowledgeAgents: (paneKeys: string[]) => void
  clearWorktreeUnread: (worktreeId: string) => void
  clearTerminalTabUnread: (tabId: string) => void
  clearTerminalPaneUnread: (paneKey: string) => void
}

export function acknowledgeViewedAgentAttention(
  state: ViewedAgentAttentionActions,
  args: {
    activeWorktreeId: string | null
    activeTabId: string
    paneKeys: string[]
    activePaneKey?: string | null
  }
): void {
  const paneKeysToClear = new Set(args.paneKeys)
  if (args.activePaneKey) {
    paneKeysToClear.add(args.activePaneKey)
  }

  if (args.paneKeys.length === 0 && paneKeysToClear.size === 0) {
    return
  }

  if (args.paneKeys.length > 0) {
    state.acknowledgeAgents(args.paneKeys)
  }
  if (args.activeWorktreeId) {
    // Why: the selected agent is now visible, so clear the Dock-driving worktree unread without a click.
    state.clearWorktreeUnread(args.activeWorktreeId)
  }
  state.clearTerminalTabUnread(args.activeTabId)
  for (const paneKey of paneKeysToClear) {
    state.clearTerminalPaneUnread(paneKey)
  }
}

export type AutoAckTabTarget = { tabId: string; worktreeId: string | null }

/**
 * Tabs whose visible pane counts as "seen" right now, each paired with the worktree that owns it.
 *
 * Why the floating workspace is gated on panel visibility rather than `activeView`: the panel is an
 * overlay that sits above every view and stays mounted while closed, and its active tab never
 * becomes the global `activeTabId` — so neither the view nor the tab id can stand in for "on screen".
 */
export function resolveAutoAckTabTargets(
  state: {
    activeView: string
    activeTabId: string | null
    activeWorktreeId: string | null
    activeTabIdByWorktree: Record<string, string | null>
  },
  options: { floatingPanelVisible: boolean }
): AutoAckTabTarget[] {
  const targets: AutoAckTabTarget[] = []
  if (state.activeView === 'terminal' && state.activeTabId) {
    targets.push({ tabId: state.activeTabId, worktreeId: state.activeWorktreeId })
  }
  if (options.floatingPanelVisible) {
    const floatingTabId = state.activeTabIdByWorktree[FLOATING_TERMINAL_WORKTREE_ID] ?? null
    // Why first-wins on a tab-id collision: tab ids can be claimed by two worktrees
    // (see active-tab-owner-worktree), and acking under the wrong one strands its unread dot.
    if (floatingTabId && !targets.some((target) => target.tabId === floatingTabId)) {
      targets.push({ tabId: floatingTabId, worktreeId: FLOATING_TERMINAL_WORKTREE_ID })
    }
  }
  return targets
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
    const maybeAck = (options?: { force?: boolean }): void => {
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
      if (targets.length === 0) {
        return
      }
      // Why: advance refs only after gates pass, else the diff is consumed and a gated-out transition never re-acks when focus returns.
      lastActiveView = s.activeView
      lastActiveTabId = s.activeTabId
      lastFloatingWorkspaceActiveTabId = floatingWorkspaceActiveTabId
      lastAgentStatus = s.agentStatusByPaneKey
      lastRetained = s.retainedAgentsByPaneKey
      lastAcknowledged = s.acknowledgedAgentsByPaneKey
      lastLayouts = s.terminalLayoutsByTabId
      lastUnreadAgentCompletionPanes = s.unreadAgentCompletionPanes

      for (const target of targets) {
        // Why re-read: acking target[0] writes to the store, which re-enters this scan synchronously
        // and may already have handled target[1]; `s` is a pre-write snapshot that would re-ack it.
        const current = useAppStore.getState()
        const tabId = target.tabId
        const activeLeafId = resolveActiveLeafId(current, tabId)
        const toAck = computeAutoAckTargets(current, tabId, activeLeafId)
        const activePaneKey = computeViewedAgentCompletionPaneKey(current, tabId, activeLeafId)
        if (toAck.length > 0 || activePaneKey) {
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
            activePaneKey
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
