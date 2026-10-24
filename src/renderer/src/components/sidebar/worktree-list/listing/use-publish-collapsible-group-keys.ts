import { useEffect } from 'react'
import { useAppStore } from '@/store'
import type { HostSectionRow } from '../../../../../../shared/sidebar-list/host-section-rows'

// Why: the header's "Collapse all" lives outside the list, so the list publishes what it renders.
export function usePublishCollapsibleGroupKeys(rows: readonly HostSectionRow[]): void {
  const setKeys = useAppStore((s) => s.setSidebarCollapsibleGroupKeys)
  useEffect(() => {
    const keys: string[] = []
    for (const row of rows) {
      if (row.type === 'header') {
        keys.push(row.collapseKey ?? row.key)
      }
    }
    setKeys(keys)
  }, [rows, setKeys])
  useEffect(() => () => setKeys([]), [setKeys])
}
