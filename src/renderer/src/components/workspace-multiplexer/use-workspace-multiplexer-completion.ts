import { useEffect, type RefObject } from 'react'
import { useAppStore } from '@/store'
import {
  FOCUS_TERMINAL_PANE_EVENT,
  TERMINAL_NOTIFICATION_EVENT,
  type FocusTerminalPaneDetail,
  type TerminalNotificationDetail
} from '@/constants/terminal'
import { parseAgentStatusPaneIdentity } from '@/lib/agent-status-worktree-attribution'
import { agentEntryCompletionAt } from '../../../../shared/agent-completion-time'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'

function latestCompletion(entry: AgentStatusEntry): number {
  return Math.max(
    agentEntryCompletionAt(entry) ?? 0,
    ...entry.stateHistory
      .filter((row) => row.state === 'done' && !row.interrupted)
      .map((row) => row.startedAt)
  )
}

export function useWorkspaceMultiplexerCompletion(root: RefObject<HTMLDivElement | null>): void {
  useEffect(() => {
    const animations = new Map<Element, Animation>()
    const cancel = (): void => {
      for (const animation of animations.values()) {
        animation.cancel()
      }
      animations.clear()
    }
    const highlightTabs = (
      state: ReturnType<typeof useAppStore.getState>,
      completedTabIds: Set<string>,
      worktreeId?: string
    ): void => {
      if (state.activeView !== 'multiplexer' || document.hidden || !root.current) {
        return
      }
      const targets = new Set<Element>()
      for (const slot of state.workspaceMultiplexer.slots) {
        if (worktreeId && slot.worktreeId !== worktreeId) {
          continue
        }
        const tabs = state.unifiedTabsByWorktree[slot.worktreeId] ?? []
        const hasCompletion = tabs.some(
          (tab) =>
            tab.contentType === 'terminal' &&
            tab.groupId === slot.groupId &&
            completedTabIds.has(tab.entityId) &&
            (tab.executionHostId ??
              state.restoredRuntimeHostIdByWorkspaceSessionKey[slot.worktreeId] ??
              'local') === (slot.executionHostId ?? 'local')
        )
        if (!hasCompletion) {
          continue
        }
        const id = CSS.escape(slot.id)
        const target =
          root.current.querySelector(`[data-workspace-multiplexer-slot-id="${id}"]`) ??
          root.current.querySelector(`[data-workspace-multiplexer-tab-id="${id}"]`)
        if (target) {
          targets.add(target)
        }
      }
      const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      for (const target of targets) {
        animations.get(target)?.cancel()
        const highlight = '0 0 0 2px var(--status-success)'
        const animation = target.animate(
          reducedMotion
            ? [{ boxShadow: highlight }, { boxShadow: highlight }]
            : [
                { boxShadow: highlight, offset: 0 },
                { boxShadow: highlight, offset: 2 / 3, easing: 'ease-out' },
                { boxShadow: getComputedStyle(target).boxShadow, offset: 1 }
              ],
          {
            duration: 3000,
            iterations: 1
          }
        )
        animation.id = 'workspace-multiplexer-completion'
        animations.set(target, animation)
        animation.onfinish = () => {
          if (animations.get(target) === animation) {
            animations.delete(target)
          }
        }
      }
    }
    const unsubscribe = useAppStore.subscribe((state, previous) => {
      if (state.activeView !== 'multiplexer') {
        cancel()
        return
      }
      if (
        previous.activeView !== 'multiplexer' ||
        state.agentStatusByPaneKey === previous.agentStatusByPaneKey
      ) {
        return
      }
      const completedTabIds = new Set<string>()
      for (const [key, entry] of Object.entries(state.agentStatusByPaneKey)) {
        const before = previous.agentStatusByPaneKey[key]
        if (!before || before === entry || latestCompletion(entry) <= latestCompletion(before)) {
          continue
        }
        const identity = parseAgentStatusPaneIdentity(key)
        if (identity) {
          completedTabIds.add(identity.tabId)
        }
      }
      if (completedTabIds.size) {
        highlightTabs(state, completedTabIds)
      }
    })
    const onFocus = (event: Event): void => {
      const detail = (event as CustomEvent<FocusTerminalPaneDetail>).detail
      if (detail.flashFocusedPane) {
        highlightTabs(useAppStore.getState(), new Set([detail.tabId]))
      }
    }
    window.addEventListener(FOCUS_TERMINAL_PANE_EVENT, onFocus)
    const onNotification = (event: Event): void => {
      const detail = (event as CustomEvent<TerminalNotificationDetail>).detail
      const state = useAppStore.getState()
      const tabIds = detail.tabId
        ? [detail.tabId]
        : (state.unifiedTabsByWorktree[detail.worktreeId] ?? []).map((tab) => tab.entityId)
      highlightTabs(state, new Set(tabIds), detail.worktreeId)
    }
    window.addEventListener(TERMINAL_NOTIFICATION_EVENT, onNotification)
    const onVisibilityChange = (): void => {
      if (document.hidden) {
        cancel()
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      unsubscribe()
      cancel()
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener(FOCUS_TERMINAL_PANE_EVENT, onFocus)
      window.removeEventListener(TERMINAL_NOTIFICATION_EVENT, onNotification)
    }
  }, [root])
}
