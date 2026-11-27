import { expect, it, vi } from 'vitest'
import { createUIStore, makePersistedUI } from './ui-slice-test-harness'

it('prunes only mode-specific group folds when switching groupBy', () => {
  const uiSet = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal('window', { api: { ui: { set: uiSet } } })
  try {
    const store = createUIStore()
    store.getState().hydratePersistedUI(
      makePersistedUI({
        groupBy: 'repo',
        collapsedGroups: [
          'bots',
          'projects-section',
          'lineage:folder:bot-home-1',
          'lineage:wt-1',
          'host:ssh:gpu',
          'pinned',
          'pinned:host:ssh:gpu',
          'repo:orca',
          'project:orca',
          'project-group:g1',
          'workspace-status:in-progress',
          'workspace-status:done:host:ssh:gpu',
          'pr:open',
          'pr:merged:host:ssh:gpu',
          'all',
          'all:host:ssh:gpu'
        ]
      })
    )

    store.getState().setGroupBy('workspace-status')

    const expectedKept = [
      'bots',
      'projects-section',
      'lineage:folder:bot-home-1',
      'lineage:wt-1',
      'host:ssh:gpu',
      'pinned',
      'pinned:host:ssh:gpu'
    ]
    expect(store.getState().groupBy).toBe('workspace-status')
    expect([...store.getState().collapsedGroups]).toEqual(expectedKept)
    expect(uiSet).toHaveBeenLastCalledWith({
      groupBy: 'workspace-status',
      collapsedGroups: expectedKept
    })

    // Switching again with no mode-specific folds left patches only groupBy and preserves the Set identity.
    const preservedSet = store.getState().collapsedGroups
    uiSet.mockClear()
    store.getState().setGroupBy('pr-status')
    expect(store.getState().groupBy).toBe('pr-status')
    expect(store.getState().collapsedGroups).toBe(preservedSet)
    expect(uiSet).toHaveBeenCalledWith({ groupBy: 'pr-status' })
  } finally {
    vi.unstubAllGlobals()
  }
})

it('ignores re-selecting the active groupBy without clearing folds or persisting', () => {
  const uiSet = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal('window', { api: { ui: { set: uiSet } } })
  try {
    const store = createUIStore()
    store.getState().hydratePersistedUI(
      makePersistedUI({
        groupBy: 'repo',
        collapsedGroups: ['bots', 'projects-section', 'repo:orca']
      })
    )
    const before = store.getState().collapsedGroups
    uiSet.mockClear()

    store.getState().setGroupBy('repo')

    expect(store.getState().collapsedGroups).toBe(before)
    expect([...store.getState().collapsedGroups]).toEqual(['bots', 'projects-section', 'repo:orca'])
    expect(uiSet).not.toHaveBeenCalled()
  } finally {
    vi.unstubAllGlobals()
  }
})
