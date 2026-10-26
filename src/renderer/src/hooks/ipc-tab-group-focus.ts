import { useAppStore } from '../store'
import { collectTabGroupLayoutGroupIds } from '../../../shared/workspace-layout/tab-group-moves'
import { activateTabGroupTab } from '@/components/tab-group/tab-group-tab-activation'
import { resolveBrowserSourceUnifiedTab } from '@/lib/browser-workspace-source-resolution'

let pendingGroupFocusFrame: number | null = null

function focusGroupEditor(worktreeId: string, groupId: string): void {
  if (pendingGroupFocusFrame !== null) {
    cancelAnimationFrame(pendingGroupFocusFrame)
  }
  pendingGroupFocusFrame = requestAnimationFrame(() => {
    pendingGroupFocusFrame = null
    const state = useAppStore.getState()
    if (
      state.activeWorktreeId !== worktreeId ||
      state.activeGroupIdByWorktree[worktreeId] !== groupId
    ) {
      return
    }
    const body = [...document.querySelectorAll<HTMLElement>('[data-tab-group-body-id]')].find(
      (element) =>
        element.dataset.tabGroupBodyId === groupId && element.dataset.worktreeId === worktreeId
    )
    const editor = body?.querySelector<HTMLElement>(
      '.monaco-editor textarea, [contenteditable="true"], [tabindex="0"]'
    )
    if (editor) {
      editor.focus()
    } else if (body) {
      body.tabIndex = -1
      body.focus()
    }
  })
}

/** Cycle visible split groups in their layout order, preserving each group's selected tab. */
export function handleFocusTabGroup(direction: 1 | -1, sourcePageId?: string): boolean {
  const state = useAppStore.getState()
  const worktreeId = state.activeWorktreeId
  if (!worktreeId) {
    return false
  }
  const sourceTab = sourcePageId
    ? resolveBrowserSourceUnifiedTab(state, sourcePageId, worktreeId)
    : undefined
  if (sourcePageId && !sourceTab) {
    return false
  }
  const groups = state.groupsByWorktree[worktreeId] ?? []
  const layout = state.layoutByWorktree[worktreeId]
  const groupIds = layout
    ? [...collectTabGroupLayoutGroupIds(layout)]
    : groups.map((group) => group.id)
  const visibleGroups = groupIds.flatMap((groupId) => {
    const group = groups.find((candidate) => candidate.id === groupId)
    return group ? [group] : []
  })
  if (visibleGroups.length <= 1) {
    return false
  }
  const currentIndex = visibleGroups.findIndex(
    (group) => group.id === (sourceTab?.groupId ?? state.activeGroupIdByWorktree[worktreeId])
  )
  const startIndex = currentIndex === -1 && direction === 1 ? -1 : Math.max(currentIndex, 0)
  const next = visibleGroups[(startIndex + direction + visibleGroups.length) % visibleGroups.length]
  const tabs = state.unifiedTabsByWorktree[worktreeId] ?? []
  const tab = tabs.find(
    (candidate) => candidate.id === next.activeTabId && candidate.groupId === next.id
  )
  // Release the old retained input before the destination claims keyboard focus.
  if (document.activeElement instanceof HTMLElement) {
    document.activeElement.blur()
  }
  state.focusGroup(worktreeId, next.id)
  if (tab) {
    activateTabGroupTab(worktreeId, tab, { focusBrowser: true, onlyIfFocusUnclaimed: true })
  }
  if (!tab || !['terminal', 'browser', 'agent-session'].includes(tab.contentType)) {
    focusGroupEditor(worktreeId, next.id)
  }
  return true
}
