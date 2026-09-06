/** Tests parked preview reuse (#11839); split out to keep editor-open-diff.test.ts under max-lines. */
import { describe, expect, it } from 'vitest'
import { createEditorTabsStore } from './editor-slice-test-harness'

describe('createEditorSlice parked preview reuse', () => {
  it('recycles a preview parked in another split group when no target group is given', () => {
    const store = createEditorTabsStore()

    store.getState().openFile({
      filePath: '/repo/pinned.ts',
      relativePath: 'pinned.ts',
      worktreeId: 'wt-1',
      language: 'typescript',
      mode: 'edit'
    })
    const groupAId = store.getState().groupsByWorktree['wt-1'][0].id
    const groupBId = store.getState().createEmptySplitGroup('wt-1', groupAId, 'right')
    if (!groupBId) {
      throw new Error('expected split group')
    }
    store.getState().openDiff('wt-1', '/repo/a.ts', 'a.ts', 'typescript', false, {
      preview: true,
      targetGroupId: groupBId
    })
    store.getState().focusGroup('wt-1', groupAId)

    store.getState().openDiff('wt-1', '/repo/b.ts', 'b.ts', 'typescript', false, { preview: true })

    const state = store.getState()
    expect(state.openFiles).toEqual([
      expect.objectContaining({ id: '/repo/pinned.ts' }),
      expect.objectContaining({ id: 'wt-1::diff::unstaged::b.ts', isPreview: true })
    ])
    const tabs = state.unifiedTabsByWorktree['wt-1']
    expect(tabs).toHaveLength(2)
    expect(tabs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ groupId: groupAId, entityId: '/repo/pinned.ts' }),
        expect.objectContaining({
          groupId: groupBId,
          entityId: 'wt-1::diff::unstaged::b.ts',
          isPreview: true
        })
      ])
    )
  })

  it('recycles a parked preview for file-explorer preview opens from another group', () => {
    const store = createEditorTabsStore()

    store.getState().openFile({
      filePath: '/repo/pinned.ts',
      relativePath: 'pinned.ts',
      worktreeId: 'wt-1',
      language: 'typescript',
      mode: 'edit'
    })
    const groupAId = store.getState().groupsByWorktree['wt-1'][0].id
    const groupBId = store.getState().createEmptySplitGroup('wt-1', groupAId, 'right')
    if (!groupBId) {
      throw new Error('expected split group')
    }
    store.getState().openDiff('wt-1', '/repo/a.ts', 'a.ts', 'typescript', false, {
      preview: true,
      targetGroupId: groupBId
    })
    store.getState().focusGroup('wt-1', groupAId)

    store.getState().openFile(
      {
        filePath: '/repo/c.ts',
        relativePath: 'c.ts',
        worktreeId: 'wt-1',
        language: 'typescript',
        mode: 'edit'
      },
      { preview: true }
    )

    const state = store.getState()
    expect(state.openFiles).toEqual([
      expect.objectContaining({ id: '/repo/pinned.ts' }),
      expect.objectContaining({ id: '/repo/c.ts', isPreview: true })
    ])
    const tabs = state.unifiedTabsByWorktree['wt-1']
    expect(tabs).toHaveLength(2)
    expect(tabs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ groupId: groupAId, entityId: '/repo/pinned.ts' }),
        expect.objectContaining({ groupId: groupBId, entityId: '/repo/c.ts', isPreview: true })
      ])
    )
  })

  it('re-activates a parked preview tab in place when reopening the same file', () => {
    const store = createEditorTabsStore()

    store.getState().openFile({
      filePath: '/repo/pinned.ts',
      relativePath: 'pinned.ts',
      worktreeId: 'wt-1',
      language: 'typescript',
      mode: 'edit'
    })
    const groupAId = store.getState().groupsByWorktree['wt-1'][0].id
    const groupBId = store.getState().createEmptySplitGroup('wt-1', groupAId, 'right')
    if (!groupBId) {
      throw new Error('expected split group')
    }
    store.getState().openDiff('wt-1', '/repo/a.ts', 'a.ts', 'typescript', false, {
      preview: true,
      targetGroupId: groupBId
    })
    store.getState().focusGroup('wt-1', groupAId)

    store.getState().openDiff('wt-1', '/repo/a.ts', 'a.ts', 'typescript', false, { preview: true })

    const state = store.getState()
    const tabs = state.unifiedTabsByWorktree['wt-1']
    expect(tabs).toHaveLength(2)
    expect(tabs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ groupId: groupAId, entityId: '/repo/pinned.ts' }),
        expect.objectContaining({
          groupId: groupBId,
          entityId: 'wt-1::diff::unstaged::a.ts',
          isPreview: true
        })
      ])
    )
  })

  it('leaves a preview parked in the active group behind when the diff column is pinned elsewhere', () => {
    const store = createEditorTabsStore()

    store.getState().openDiff('wt-1', '/repo/a.ts', 'a.ts', 'typescript', false, { preview: true })
    const groupAId = store.getState().groupsByWorktree['wt-1'][0].id
    const groupBId = store.getState().createEmptySplitGroup('wt-1', groupAId, 'right')
    if (!groupBId) {
      throw new Error('expected split group')
    }

    store.getState().openDiff('wt-1', '/repo/b.ts', 'b.ts', 'typescript', false, {
      preview: true,
      targetGroupId: groupBId
    })

    // Why: pinning scopes replacement to the new split, so the parked preview survives once.
    const tabs = store.getState().unifiedTabsByWorktree['wt-1']
    expect(tabs).toHaveLength(2)
    expect(tabs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          groupId: groupAId,
          entityId: 'wt-1::diff::unstaged::a.ts',
          isPreview: true
        }),
        expect.objectContaining({
          groupId: groupBId,
          entityId: 'wt-1::diff::unstaged::b.ts',
          isPreview: true
        })
      ])
    )

    // Why: once the column is recorded, every later open replaces the split's preview in place.
    store.getState().openDiff('wt-1', '/repo/c.ts', 'c.ts', 'typescript', false, {
      preview: true,
      targetGroupId: groupBId
    })

    const settled = store.getState().unifiedTabsByWorktree['wt-1']
    expect(settled).toHaveLength(2)
    expect(settled).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ groupId: groupAId, entityId: 'wt-1::diff::unstaged::a.ts' }),
        expect.objectContaining({ groupId: groupBId, entityId: 'wt-1::diff::unstaged::c.ts' })
      ])
    )
  })
})
