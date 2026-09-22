import { describe, expect, it } from 'vitest'
import type { Tab } from '../../../shared/tab-types'
import { buildWebSessionExistingTabIndex } from './web-session-existing-tab-index'

const WT = 'repo::/worktree'

function makeTab(id: string, entityId: string, contentType: 'editor' | 'browser'): Tab {
  return {
    id,
    entityId,
    groupId: 'group-1',
    worktreeId: WT,
    contentType,
    label: id,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

describe('buildWebSessionExistingTabIndex', () => {
  it('preserves first-match editor lookup behavior across both accepted keys', () => {
    const firstFileId = '/repo/file.ts'
    const firstByFileId = makeTab('older-host-id', firstFileId, 'editor')
    const laterByHostId = makeTab('current-host-id', '/repo/other.ts', 'editor')
    const index = buildWebSessionExistingTabIndex({
      unifiedTabs: [firstByFileId, laterByHostId]
    })

    expect(index.getEditorUnifiedTab(firstFileId, laterByHostId.id)).toBe(firstByFileId)
    expect(index.getEditorUnifiedTab(laterByHostId.entityId, firstByFileId.id)).toBe(firstByFileId)
  })

  it('ignores browser tabs and returns null when neither key matches', () => {
    const index = buildWebSessionExistingTabIndex({
      unifiedTabs: [makeTab('browser-tab', 'workspace-1', 'browser')]
    })

    expect(index.getEditorUnifiedTab('/repo/missing.ts', 'absent-host-id')).toBeNull()
  })

  it('resolves by host tab id and by file id independently', () => {
    const byHostId = makeTab('host-1', '/repo/a.ts', 'editor')
    const index = buildWebSessionExistingTabIndex({ unifiedTabs: [byHostId] })

    expect(index.getEditorUnifiedTab('/repo/unrelated.ts', 'host-1')).toBe(byHostId)
    expect(index.getEditorUnifiedTab('/repo/a.ts', 'unrelated-host')).toBe(byHostId)
  })
})
