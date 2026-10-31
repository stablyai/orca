import { useEffect, useRef } from 'react'
import { useAppStore } from '@/store'
import type { SidebarCollapsibleGroup } from '@/store/slices/ui/ui-slice-contract-preferences'
import {
  getRunningProjectTransitions,
  toRunningByGroupKey,
  type RunningByGroupKey
} from './running-project-transitions'

// A project collapses as its last terminal ends and expands as one starts. Only transitions
// act, so a project the user re-expands stays open.
export function useAutoCollapseIdleProjects(groups: readonly SidebarCollapsibleGroup[]): void {
  // Why: terminals reattach one by one after launch; acting before then would rewrite every project.
  const restorationReady = useAppStore((s) => s.terminalStartupRestorationReady)
  const setGroupsCollapsed = useAppStore((s) => s.setGroupsCollapsed)
  const previous = useRef<RunningByGroupKey | null>(null)
  useEffect(() => {
    if (!restorationReady) {
      previous.current = null
      return
    }
    const current = toRunningByGroupKey(groups)
    if (previous.current) {
      const { stopped, started } = getRunningProjectTransitions(previous.current, current)
      if (stopped.length > 0) {
        setGroupsCollapsed(stopped, true)
      }
      if (started.length > 0) {
        setGroupsCollapsed(started, false)
      }
    }
    previous.current = current
  }, [groups, restorationReady, setGroupsCollapsed])
}
