import { useLayoutEffect } from 'react'
import { create } from 'zustand'
import { useAppStore } from '@/store'
import { requestVirtualizedScrollAnchorRecord } from '@/hooks/requestVirtualizedScrollAnchorRecord'
import { shouldCollapseAllGroups } from '../../../shared/sidebar-list/section-collapse'

const useSidebarGroupScope = create<{ keys: readonly string[] }>(() => ({ keys: [] }))

export function registerSidebarGroupCollapseScope(keys: readonly string[]): () => void {
  useSidebarGroupScope.setState({ keys })
  return () => {
    if (useSidebarGroupScope.getState().keys === keys) {
      useSidebarGroupScope.setState({ keys: [] })
    }
  }
}

/** The mounted list owns membership; menu and command use the same pre-collapse scope. */
export function useSidebarGroupCollapseScope(keys: readonly string[]): void {
  useLayoutEffect(() => registerSidebarGroupCollapseScope(keys), [keys])
}

export function hasSidebarGroupCollapseScope(): boolean {
  return useSidebarGroupScope.getState().keys.length > 0
}

export function setSidebarGroupsCollapsed(collapsed: boolean): boolean {
  const { keys } = useSidebarGroupScope.getState()
  if (keys.length === 0) {
    return false
  }
  const store = useAppStore.getState()
  requestVirtualizedScrollAnchorRecord('[data-worktree-sidebar]')
  store.setGroupsCollapsed(keys, collapsed)
  return true
}

export function toggleSidebarGroupsCollapse(): boolean {
  const { keys } = useSidebarGroupScope.getState()
  return setSidebarGroupsCollapsed(
    shouldCollapseAllGroups(keys, useAppStore.getState().collapsedGroups)
  )
}

export function useSidebarGroupCollapseAction() {
  const keys = useSidebarGroupScope((s) => s.keys)
  const collapseOnToggle = useAppStore((s) => shouldCollapseAllGroups(keys, s.collapsedGroups))
  return { collapseOnToggle, disabled: keys.length === 0, setCollapsed: setSidebarGroupsCollapsed }
}
