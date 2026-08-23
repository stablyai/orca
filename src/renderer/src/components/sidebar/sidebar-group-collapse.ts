import type { HostSectionRow } from './host-section-rows'

export function getCollapsibleSidebarGroupKeys(rows: readonly HostSectionRow[]): string[] {
  return rows.flatMap((row) => (row.type === 'header' && row.count > 0 ? [row.key] : []))
}
