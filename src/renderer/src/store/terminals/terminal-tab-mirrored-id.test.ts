import { describe, expect, it } from 'vitest'
import { createTestStore, makeWorktree, seedStore } from '../slices/store-test-helpers'
import { createStoreCascadesMockApi } from '../slices/store-cascades-test-harness'
import { toWebTerminalSurfaceTabId } from '../../../../shared/terminal-surface-id'
createStoreCascadesMockApi()
const WT = 'repo1::/path/wt1'
const MIRRORED = toWebTerminalSurfaceTabId('host-tab-1')
function seeded() {
  const store = createTestStore()
  seedStore(store, {
    worktreesByRepo: { repo1: [makeWorktree({ id: WT, repoId: 'repo1', path: '/path/wt1' })] },
    activeWorktreeId: WT
  })
  return store
}
describe('createTab with a mirrored host tab id', () => {
  it('keeps the id so the host snapshot finds the tab', () => {
    const store = seeded()
    const tab = store.getState().createTab(WT, undefined, undefined, {
      id: MIRRORED,
      mirroredHostTab: true
    })
    expect(tab.id).toBe(MIRRORED)
    expect(store.getState().tabsByWorktree[WT]?.map((entry) => entry.id)).toContain(MIRRORED)
    expect(() =>
      store.getState().createTab(WT, undefined, undefined, { id: MIRRORED, mirroredHostTab: true })
    ).toThrow(/already exists/)
  })
  it('still ignores a mirrored id from a caller that did not opt in', () => {
    const tab = seeded().getState().createTab(WT, undefined, undefined, { id: MIRRORED })
    expect(tab.id).not.toBe(MIRRORED)
  })
  it('ignores an opted-in id that is not a mirror of a valid host tab id', () => {
    const tab = seeded().getState().createTab(WT, undefined, undefined, {
      id: 'plain-tab',
      mirroredHostTab: true
    })
    expect(tab.id).not.toBe('plain-tab')
  })
})
