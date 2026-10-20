import { requestBrowserFocus } from '@/components/browser-pane/host-guest/browser-focus'
import { escapeCssAttrValue } from '@/components/tab-group/tab-group-panel-split-target'
import { requestNativeChatComposerFocus } from '@/components/native-chat/use-native-chat-composer-reveal-focus'
import { focusTerminalTabSurface } from '@/lib/focus-terminal-tab-surface'
import { runtimeEnvironmentIdWithLegacyFallbackUnlessTwin } from '@/lib/worktree-runtime-owner'
import { activateWebRuntimeSessionTab } from '@/runtime/web-runtime-session-tab-lifecycle'
import { isWebRuntimeSessionActive } from '@/runtime/web-runtime-session-environment'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import type { Tab } from '../../../shared/tab-types'
import {
  findTabGroupNeighbor,
  type TabGroupFocusDirection
} from '../../../shared/workspace-layout/tab-group-neighbor'

/** Focusable editor DOM, most specific first; editor surfaces own varied focusable elements. */
export const EDITOR_SURFACE_FOCUS_SELECTORS: readonly string[] = [
  '.monaco-editor textarea',
  '.rich-markdown-editor[contenteditable="true"]',
  '.markdown-preview'
]

function focusGroupEditorSurface(groupId: string): void {
  // Why: double rAF lets the store-driven render settle before looking for the editor DOM.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const body = document.querySelector(
        `[data-tab-group-body-id="${escapeCssAttrValue(groupId)}"]`
      )
      for (const selector of EDITOR_SURFACE_FOCUS_SELECTORS) {
        const target = body?.querySelector<HTMLElement>(selector)
        if (!target) {
          continue
        }
        target.focus()
        if (document.activeElement === target || target.contains(document.activeElement)) {
          return
        }
      }
    })
  })
}

function moveDomFocusToGroup(state: AppState, groupId: string, tab: Tab | null): void {
  // Why: keys must stop reaching the previous group's surface even when the target has nothing focusable.
  if (document.activeElement instanceof HTMLElement) {
    document.activeElement.blur()
  }
  if (!tab) {
    return
  }
  switch (tab.contentType) {
    case 'terminal': {
      const environmentId = runtimeEnvironmentIdWithLegacyFallbackUnlessTwin(state, tab.worktreeId)
      if (isWebRuntimeSessionActive(environmentId)) {
        void activateWebRuntimeSessionTab({
          worktreeId: tab.worktreeId,
          tabId: tab.entityId,
          environmentId
        })
      }
      focusTerminalTabSurface(
        tab.entityId,
        state.terminalLayoutsByTabId[tab.entityId]?.activeLeafId ?? null
      )
      break
    }
    case 'agent-session':
      requestNativeChatComposerFocus(tab.id)
      break
    case 'browser': {
      const pageId = (state.browserTabsByWorktree[tab.worktreeId] ?? []).find(
        (workspace) => workspace.id === tab.entityId
      )?.activePageId
      if (pageId) {
        requestBrowserFocus({ pageId, target: 'webview' })
      }
      break
    }
    case 'simulator':
      // The emulator frame has no per-group focus target; the blur above releases the old group.
      break
    case 'editor':
    case 'diff':
    case 'conflict-review':
    case 'check-details':
      focusGroupEditorSurface(groupId)
  }
}

/** Moves focus to the tab group beside the active one, as a click on that group would. */
export function focusTabGroupInDirection(direction: TabGroupFocusDirection): boolean {
  const state = useAppStore.getState()
  const worktreeId = state.activeWorktreeId
  if (state.activeView !== 'terminal' || !worktreeId) {
    return false
  }
  const layout = state.layoutByWorktree[worktreeId]
  const activeGroupId = state.activeGroupIdByWorktree[worktreeId]
  if (!layout || !activeGroupId) {
    return false
  }
  const groups = state.groupsByWorktree[worktreeId] ?? []
  const tabs = state.unifiedTabsByWorktree[worktreeId] ?? []
  const lastFocusedAtByGroupId = new Map<string, number>()
  for (const tab of tabs) {
    const previous = lastFocusedAtByGroupId.get(tab.groupId) ?? 0
    lastFocusedAtByGroupId.set(tab.groupId, Math.max(previous, tab.lastFocusedAt ?? 0))
  }
  const targetGroupId = findTabGroupNeighbor(
    layout,
    activeGroupId,
    direction,
    (groupId) => lastFocusedAtByGroupId.get(groupId) ?? 0
  )
  const target = groups.find((group) => group.id === targetGroupId)
  if (!target) {
    return false
  }
  state.focusGroup(worktreeId, target.id)
  const activeTab =
    tabs.find((tab) => tab.id === target.activeTabId && tab.groupId === target.id) ?? null
  if (activeTab) {
    // Why: record the focus for MRU like a click, without pinning a preview tab.
    state.activateTab(activeTab.id, { worktreeId, preservePreview: true })
  }
  moveDomFocusToGroup(useAppStore.getState(), target.id, activeTab)
  return true
}
