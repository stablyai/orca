import { describe, expect, it } from 'vitest'
import { toAppSshPtyId } from '../../../../shared/ssh-pty-id'
import type { AppState } from '../types'
import { buildRemovedSshTargetCleanupPatch } from './ssh-target-cleanup'
import { createTestStore, makeTab } from './store-test-helpers'

function freezeTabs(tabsByWorktree: AppState['tabsByWorktree']): AppState['tabsByWorktree'] {
  for (const tabs of Object.values(tabsByWorktree)) {
    tabs.forEach(Object.freeze)
    Object.freeze(tabs)
  }
  return Object.freeze(tabsByWorktree)
}

describe('SSH target cleanup tab map', () => {
  it.each([1, 10])('preserves frozen inputs and untouched identities with stride %i', (stride) => {
    const tabsByWorktree = freezeTabs(
      Object.fromEntries(
        Array.from({ length: 100 }, (_, index) => {
          const worktreeId = `folder:${index}`
          return [
            worktreeId,
            [
              makeTab({
                id: `tab-${index}`,
                worktreeId,
                ptyId: toAppSshPtyId(index % stride === 0 ? 'removed' : 'other', 'pty'),
                pendingActivationSpawn: true
              }),
              makeTab({ id: `untouched-${index}`, worktreeId, ptyId: 'local-pty' })
            ]
          ]
        })
      )
    )
    const state = Object.freeze({ ...createTestStore().getState(), tabsByWorktree })
    const patch = buildRemovedSshTargetCleanupPatch(state, 'removed')!
    expect(patch.tabsByWorktree).not.toBe(tabsByWorktree)
    expect(Object.keys(patch.tabsByWorktree!)).toEqual(Object.keys(tabsByWorktree))
    Object.entries(tabsByWorktree).forEach(([key, tabs], index) => {
      const nextTabs = patch.tabsByWorktree![key]
      expect(nextTabs[1]).toBe(tabs[1])
      expect(tabs[0].pendingActivationSpawn).toBe(true)
      expect(tabs[0].ptyId).not.toBeNull()
      if (index % stride === 0) {
        expect(nextTabs).not.toBe(tabs)
        expect(nextTabs[0]).not.toBe(tabs[0])
        const { pendingActivationSpawn: _, ...retained } = tabs[0]
        expect(nextTabs[0]).toEqual({ ...retained, ptyId: null })
      } else {
        expect(nextTabs).toBe(tabs)
        expect(nextTabs[0]).toBe(tabs[0])
      }
    })
  })

  it('clears folder tabs matched only by split or last-known PTYs', () => {
    const removedPtyId = toAppSshPtyId('removed', 'pty')
    const tabsByWorktree = freezeTabs({
      'folder:split': [makeTab({ id: 'split', worktreeId: 'folder:split' })],
      'folder:last': [makeTab({ id: 'last', worktreeId: 'folder:last' })],
      'folder:empty': [makeTab({ id: 'empty', worktreeId: 'folder:empty' })]
    })
    const state = Object.freeze({
      ...createTestStore().getState(),
      tabsByWorktree,
      ptyIdsByTabId: Object.freeze({ split: [removedPtyId] }),
      lastKnownRelayPtyIdByTabId: Object.freeze({ last: removedPtyId }),
      pendingCodexPaneRestartIds: Object.freeze({ [removedPtyId]: true as const }),
      codexRestartNoticeByPtyId: Object.freeze({
        [removedPtyId]: { previousAccountLabel: 'old', nextAccountLabel: 'new' }
      })
    })
    const patch = buildRemovedSshTargetCleanupPatch(state, 'removed')!
    expect(patch.tabsByWorktree!['folder:split']).not.toBe(tabsByWorktree['folder:split'])
    expect(patch.tabsByWorktree!['folder:last']).not.toBe(tabsByWorktree['folder:last'])
    expect(patch.tabsByWorktree!['folder:empty']).toBe(tabsByWorktree['folder:empty'])
    expect(patch.ptyIdsByTabId).toEqual({ split: [], last: [] })
    expect(patch.lastKnownRelayPtyIdByTabId).toEqual({})
    expect(patch.pendingCodexPaneRestartIds).toEqual({})
    expect(patch.codexRestartNoticeByPtyId).toEqual({})
  })

  it.each([false, true])('preserves own special keys with null prototype = %s', (nullPrototype) => {
    const keys = ['__proto__', 'constructor', 'toString', 'folder:normal']
    const tabsByWorktree = Object.fromEntries(
      keys.map((worktreeId) => [
        worktreeId,
        [makeTab({ id: `tab-${worktreeId}`, worktreeId, ptyId: toAppSshPtyId('removed', 'pty') })]
      ])
    )
    if (nullPrototype) {
      Object.setPrototypeOf(tabsByWorktree, null)
    }
    freezeTabs(tabsByWorktree)
    const patch = buildRemovedSshTargetCleanupPatch(
      Object.freeze({ ...createTestStore().getState(), tabsByWorktree }),
      'removed'
    )!
    expect(Object.getPrototypeOf(patch.tabsByWorktree)).toBe(Object.prototype)
    expect(Object.keys(patch.tabsByWorktree!)).toEqual(keys)
    for (const key of keys) {
      expect(Object.hasOwn(patch.tabsByWorktree!, key)).toBe(true)
      expect(patch.tabsByWorktree![key][0].ptyId).toBeNull()
      expect(tabsByWorktree[key][0].ptyId).not.toBeNull()
    }
  })

  it('does not publish or replace the tab map when only target metadata changes', () => {
    const store = createTestStore()
    const tabsByWorktree = freezeTabs({
      'folder:other': [
        makeTab({
          id: 'other',
          worktreeId: 'folder:other',
          ptyId: toAppSshPtyId('other', 'pty')
        })
      ]
    })
    store.setState({ tabsByWorktree })
    const before = store.getState()
    store.getState().clearRemovedSshTargetState('removed')
    expect(store.getState()).toBe(before)
    store.setState({ deferredSshReconnectTargets: ['removed'] })
    const patch = buildRemovedSshTargetCleanupPatch(store.getState(), 'removed')
    expect(patch).toEqual({ deferredSshReconnectTargets: [] })
    store.getState().clearRemovedSshTargetState('removed')
    expect(store.getState().tabsByWorktree).toBe(tabsByWorktree)
  })
})
