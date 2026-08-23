import { describe, expect, it } from 'vitest'
import type { HostSectionRow } from './host-section-rows'
import { getCollapsibleSidebarGroupKeys } from './sidebar-group-collapse'

describe('getCollapsibleSidebarGroupKeys', () => {
  it('returns populated project sections without host or workspace rows', () => {
    const rows = [
      { type: 'host-header', key: 'host:local' },
      { type: 'header', key: 'project:one', count: 2 },
      { type: 'header', key: 'project:empty', count: 0 },
      { type: 'item', rowKey: 'project:one:workspace-1' }
    ] as unknown as HostSectionRow[]

    expect(getCollapsibleSidebarGroupKeys(rows)).toEqual(['project:one'])
  })
})
