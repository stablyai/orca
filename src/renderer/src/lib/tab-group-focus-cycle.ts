import { useAppStore } from '@/store'
import { getEffectiveLayoutForWorktree } from '@/components/terminal/split-group-mount'
import { requestBrowserFocus } from '@/components/browser-pane/host-guest/browser-focus'
import { requestNativeChatComposerFocus } from '@/components/native-chat/use-native-chat-composer-reveal-focus'
import { getTabGroupBodyElement } from '@/components/tab-group/tab-group-panel-split-target'
import { focusTerminalTabSurface } from './focus-terminal-tab-surface'
import { collectTabGroupLayoutGroupIds } from '../../../shared/workspace-layout/tab-group-moves'
import type { Tab, TabGroup, TabGroupLayoutNode } from '../../../shared/tab-types'

// Why: diff views type into the modified side; Monaco takes keys in an EditContext div or, without it, a textarea.
const EDITOR_INPUT_SELECTORS = [
  '.editor.modified .native-edit-context',
  '.editor.modified textarea.inputarea',
  '.native-edit-context',
  'textarea.inputarea',
  '[contenteditable="true"]'
]

/** Layout leaves read first-then-second, which is left-to-right and top-to-bottom on screen. */
export function resolveAdjacentTabGroupId(
  layout: TabGroupLayoutNode | undefined,
  groups: readonly Pick<TabGroup, 'id'>[],
  activeGroupId: string | undefined,
  direction: 1 | -1
): string | null {
  const groupIds = [...collectTabGroupLayoutGroupIds(layout)].filter((groupId) =>
    groups.some((group) => group.id === groupId)
  )
  if (groupIds.length < 2) {
    return null
  }
  const index = activeGroupId ? groupIds.indexOf(activeGroupId) : -1
  if (index === -1) {
    return groupIds[0]
  }
  return groupIds[(index + direction + groupIds.length) % groupIds.length]
}

function focusEditorInGroupBody(worktreeId: string, groupId: string): void {
  requestAnimationFrame(() => {
    const body = getTabGroupBodyElement(groupId, worktreeId)
    const input = EDITOR_INPUT_SELECTORS.map((selector) =>
      body?.querySelector<HTMLElement>(selector)
    ).find(Boolean)
    if (input) {
      input.focus()
      return
    }
    // Why: a surface without a text input (image, simulator) must still stop keys reaching the old split.
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur()
    }
  })
}

function focusGroupActiveTab(worktreeId: string, groupId: string, tab: Tab | undefined): void {
  if (tab?.contentType === 'terminal') {
    // Why: without a leaf the helper picks the first pane in DOM order, not the one last used.
    const leafId = useAppStore.getState().terminalLayoutsByTabId[tab.entityId]?.activeLeafId
    focusTerminalTabSurface(tab.entityId, leafId)
    return
  }
  if (tab?.contentType === 'agent-session') {
    requestNativeChatComposerFocus(tab.id)
    return
  }
  if (tab?.contentType === 'browser') {
    const pageId = useAppStore
      .getState()
      .browserTabsByWorktree[worktreeId]?.find(
        (workspace) => workspace.id === tab.entityId
      )?.activePageId
    if (pageId) {
      requestBrowserFocus({ pageId, target: 'webview' })
      return
    }
  }
  focusEditorInGroupBody(worktreeId, groupId)
}

/** Moves keyboard focus to the neighboring split, keeping each split's active tab. */
export function focusAdjacentTabGroup(worktreeId: string, direction: 1 | -1): boolean {
  const state = useAppStore.getState()
  const groups = state.groupsByWorktree[worktreeId] ?? []
  const layout = getEffectiveLayoutForWorktree(
    worktreeId,
    state.layoutByWorktree,
    state.groupsByWorktree,
    state.activeGroupIdByWorktree
  )
  const targetGroupId = resolveAdjacentTabGroupId(
    layout,
    groups,
    state.activeGroupIdByWorktree[worktreeId],
    direction
  )
  if (!targetGroupId) {
    return false
  }
  state.focusGroup(worktreeId, targetGroupId)
  const activeTabId = groups.find((group) => group.id === targetGroupId)?.activeTabId
  const tab = (state.unifiedTabsByWorktree[worktreeId] ?? []).find(
    (candidate) => candidate.id === activeTabId
  )
  // Why: focusGroup only moves store selection; the previous split's DOM focus would keep taking keys.
  focusGroupActiveTab(worktreeId, targetGroupId, tab)
  return true
}
