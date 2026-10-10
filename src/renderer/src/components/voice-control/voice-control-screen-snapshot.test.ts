import { describe, expect, it } from 'vitest'
import type { Tab, TabGroup } from '../../../../shared/tab-types'
import { makeWorktree } from '../../store/slices/store-test-helpers'
import {
  buildVoiceScreenSnapshot,
  type VoiceScreenSnapshotSource
} from './voice-control-screen-snapshot'

const WORKTREE_ID = 'r1::/tmp/wt'

function makeTab(overrides: Partial<Tab> & { id: string }): Tab {
  return {
    entityId: overrides.id,
    groupId: 'g1',
    worktreeId: WORKTREE_ID,
    contentType: 'terminal',
    label: 'Terminal 1',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 1,
    ...overrides
  }
}

function makeGroup(activeTabId: string | null): TabGroup {
  return { id: 'g1', worktreeId: WORKTREE_ID, activeTabId, tabOrder: [] }
}

function source(overrides: Partial<VoiceScreenSnapshotSource> = {}): VoiceScreenSnapshotSource {
  return {
    activeView: 'worktree',
    sidebarOpen: true,
    rightSidebarOpen: false,
    rightSidebarTab: 'explorer',
    activeWorktreeId: WORKTREE_ID,
    worktreesByRepo: {
      r1: [makeWorktree({ id: WORKTREE_ID, repoId: 'r1', displayName: 'oak' })]
    },
    unifiedTabsByWorktree: { [WORKTREE_ID]: [makeTab({ id: 't1' }), makeTab({ id: 't2' })] },
    groupsByWorktree: { [WORKTREE_ID]: [makeGroup('t2')] },
    activeGroupIdByWorktree: { [WORKTREE_ID]: 'g1' },
    ...overrides
  }
}

describe('buildVoiceScreenSnapshot', () => {
  it('names the workspace and marks only the group-active tab', () => {
    const snap = buildVoiceScreenSnapshot(source())
    expect(snap.worktreeName).toBe('oak')
    expect(snap.tabs).toEqual([
      { title: 'Terminal 1', contentType: 'terminal', active: false },
      { title: 'Terminal 1', contentType: 'terminal', active: true }
    ])
    expect(snap.leftSidebarOpen).toBe(true)
    expect(snap.rightSidebar).toBeNull()
  })

  // Two workspaces can share a display name ("main"); the branch is the disambiguator
  // the sidebar shows, so the snapshot carries it in the same short form.
  it('carries the workspace branch in the sidebar’s short form', () => {
    const snap = buildVoiceScreenSnapshot(
      source({
        worktreesByRepo: {
          r1: [makeWorktree({ id: WORKTREE_ID, repoId: 'r1', branch: 'refs/heads/j-madrone/main' })]
        }
      })
    )
    expect(snap.worktreeBranch).toBe('j-madrone/main')
  })

  it('prefers customLabel over generatedLabel over the raw label', () => {
    const snap = buildVoiceScreenSnapshot(
      source({
        unifiedTabsByWorktree: {
          [WORKTREE_ID]: [
            makeTab({ id: 't1', label: 'raw', generatedLabel: 'generated', customLabel: 'custom' }),
            makeTab({ id: 't2', label: 'raw2', generatedLabel: 'generated2' }),
            makeTab({ id: 't3', label: 'raw3' })
          ]
        }
      })
    )
    expect(snap.tabs.map((tab) => tab.title)).toEqual(['custom', 'generated2', 'raw3'])
  })

  it('reports no workspace and no tabs when nothing is selected', () => {
    const snap = buildVoiceScreenSnapshot(
      source({ activeWorktreeId: null, activeView: 'settings' })
    )
    expect(snap.view).toBe('settings')
    expect(snap.worktreeName).toBeNull()
    expect(snap.tabs).toEqual([])
  })

  it('names the right sidebar tab only while the sidebar is open', () => {
    expect(buildVoiceScreenSnapshot(source({ rightSidebarOpen: true })).rightSidebar).toBe(
      'explorer'
    )
    expect(buildVoiceScreenSnapshot(source({ rightSidebarOpen: false })).rightSidebar).toBeNull()
  })
})
