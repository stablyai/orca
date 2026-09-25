import { describe, expect, it } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import { LOCAL_EXECUTION_HOST_ID, toSshExecutionHostId } from '../../../../shared/execution-host'
import { createTestStore, makeWorktree, seedStore } from './store-test-helpers'

describe('floating workspace renderer row', () => {
  it('resolves the floating id to a synthetic row while a different workspace is active', () => {
    const store = createTestStore()
    seedStore(store, {
      activeWorktreeId: 'wt-main',
      worktreesByRepo: { 'repo-1': [makeWorktree({ id: 'wt-main', repoId: 'repo-1' })] }
    })
    store.getState().setFloatingWorkspacePath('/floating/dir')

    const row = store.getState().getKnownWorktreeById(FLOATING_TERMINAL_WORKTREE_ID)
    expect(row).toMatchObject({
      id: FLOATING_TERMINAL_WORKTREE_ID,
      path: '/floating/dir',
      hostId: 'local'
    })
    // The lookup must not depend on the globally active workspace.
    expect(store.getState().activeWorktreeId).toBe('wt-main')
  })

  it('returns undefined until the host has resolved a directory', () => {
    const store = createTestStore()
    expect(store.getState().floatingWorkspacePath).toBeNull()
    expect(store.getState().getKnownWorktreeById(FLOATING_TERMINAL_WORKTREE_ID)).toBeUndefined()
  })

  it('answers only for the local execution host', () => {
    const store = createTestStore()
    store.getState().setFloatingWorkspacePath('/floating/dir')
    expect(
      store.getState().getKnownWorktreeById(FLOATING_TERMINAL_WORKTREE_ID, LOCAL_EXECUTION_HOST_ID)
    ).toBeDefined()
    expect(
      store
        .getState()
        .getKnownWorktreeById(FLOATING_TERMINAL_WORKTREE_ID, toSshExecutionHostId('remote-host'))
    ).toBeUndefined()
  })

  it('keeps row identity stable while the directory is unchanged', () => {
    const store = createTestStore()
    store.getState().setFloatingWorkspacePath('/floating/dir')
    const first = store.getState().getKnownWorktreeById(FLOATING_TERMINAL_WORKTREE_ID)
    const second = store.getState().getKnownWorktreeById(FLOATING_TERMINAL_WORKTREE_ID)
    expect(second).toBe(first)

    store.getState().setFloatingWorkspacePath('/floating/other')
    const third = store.getState().getKnownWorktreeById(FLOATING_TERMINAL_WORKTREE_ID)
    expect(third).not.toBe(first)
    expect(third?.path).toBe('/floating/other')
  })
})
