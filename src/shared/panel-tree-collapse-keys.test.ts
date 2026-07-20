import { describe, expect, it } from 'vitest'
import { migrateCollapsedPanelGroupKeys } from './panel-tree-collapse-keys'
import type { PanelTreeGroup } from './types'

const groups: PanelTreeGroup[] = [
  { id: 'id-e', title: 'node-e', root: 'nodes', parentId: null, order: 0 },
  { id: 'id-a', title: 'node-a', root: 'nodes', parentId: null, order: 1 }
]

describe('migrateCollapsedPanelGroupKeys', () => {
  it('maps legacy title keys to group ids', () => {
    const next = migrateCollapsedPanelGroupKeys(
      groups,
      ['node-e', 'node-a', '\0nodes-root'],
      '\0nodes-root'
    )
    expect(next).toEqual(['id-a', 'id-e', '\0nodes-root'].sort())
  })

  it('returns null when already id-based', () => {
    expect(migrateCollapsedPanelGroupKeys(groups, ['id-e'], '\0nodes-root')).toBeNull()
  })
})
