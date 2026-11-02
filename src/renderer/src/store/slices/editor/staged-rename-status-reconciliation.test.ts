import { describe, expect, it } from 'vitest'
import { createEditorStore } from '../editor-slice-test-harness'

function openRenamedDiff() {
  const store = createEditorStore()
  store.getState().openDiff('wt-1', '/repo/new.ts', 'new.ts', 'typescript', true, {
    oldPath: 'old.ts'
  })
  return store
}

describe('staged rename status reconciliation', () => {
  it.each(['added', 'modified'] as const)(
    'clears the former source when the destination is now %s',
    (status) => {
      const store = openRenamedDiff()
      store.getState().setGitStatus('wt-1', {
        conflictOperation: 'unknown',
        entries: [
          { path: 'new.ts', status, area: 'staged' },
          { path: 'new.ts', status: 'renamed', area: 'unstaged', oldPath: 'unrelated.ts' }
        ]
      })

      expect(store.getState().openFiles[0].branchOldPath).toBeUndefined()
      expect(store.getState().openFiles[0]).toMatchObject({
        relativePath: 'new.ts',
        diffSource: 'staged'
      })
    }
  )

  it('updates the staged source and keeps unchanged file identities on repeated status', () => {
    const store = openRenamedDiff()
    const entries = [
      { path: 'new.ts', status: 'renamed', area: 'staged', oldPath: 'another.ts' },
      { path: 'new.ts', status: 'modified', area: 'unstaged' }
    ] as const
    store.getState().setGitStatus('wt-1', { conflictOperation: 'unknown', entries: [...entries] })
    expect(store.getState().openFiles[0].branchOldPath).toBe('another.ts')

    const files = store.getState().openFiles
    store.getState().setGitStatus('wt-1', { conflictOperation: 'unknown', entries: [...entries] })
    expect(store.getState().openFiles).toBe(files)
  })

  it('retains captured context when the staged area disappears or a different workspace refreshes', () => {
    const store = openRenamedDiff()
    const files = store.getState().openFiles
    store.getState().setGitStatus('wt-1', {
      conflictOperation: 'unknown',
      entries: [{ path: 'new.ts', status: 'modified', area: 'unstaged' }]
    })
    expect(store.getState().openFiles).toBe(files)
    store.getState().setGitStatus('wt-other', {
      conflictOperation: 'unknown',
      entries: [{ path: 'new.ts', status: 'modified', area: 'staged' }]
    })
    expect(store.getState().openFiles).toBe(files)
    expect(files[0].branchOldPath).toBe('old.ts')
  })
})
