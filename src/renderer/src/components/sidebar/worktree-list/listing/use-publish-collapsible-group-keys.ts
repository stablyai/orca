import { useEffect, useMemo } from 'react'
import { useAppStore } from '@/store'
import type { SidebarCollapsibleGroup } from '@/store/slices/ui/ui-slice-contract-preferences'
import type { HostSectionRow } from '../../../../../../shared/sidebar-list/host-section-rows'
import { useAutoCollapseIdleProjects } from './use-auto-collapse-idle-projects'

// Why: the header's "Collapse all" lives outside the list, so the list publishes what it renders.
export function usePublishCollapsibleGroupKeys(
  rows: readonly HostSectionRow[],
  listHidden: boolean
): void {
  const setGroups = useAppStore((s) => s.setSidebarCollapsibleGroups)
  const groups = useMemo(() => {
    const result: SidebarCollapsibleGroup[] = []
    // Why: the empty state replaces the list, so its headers are not on screen to collapse.
    for (const row of listHidden ? [] : rows) {
      if (row.type === 'header') {
        result.push({ key: row.collapseKey ?? row.key, running: row.running === true })
      }
    }
    return result
  }, [rows, listHidden])
  useEffect(() => setGroups(groups), [groups, setGroups])
  useEffect(() => () => setGroups([]), [setGroups])
  useAutoCollapseIdleProjects(groups)
}
