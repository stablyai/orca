import { describe, expect, it } from 'vitest'
import {
  isWorkspaceStillRegistered,
  resolveWorktreeRemovalRespawnDecision
} from './worktree-removal-respawn'

describe('resolveWorktreeRemovalRespawnDecision', () => {
  it('waits while this workspace is still being removed', () => {
    expect(resolveWorktreeRemovalRespawnDecision({ 'wt-1': { isDeleting: true } }, true)).toBe(
      'wait'
    )
  })

  // Why: an overlapping parent/child root removal fences this pane's spawn in main
  // even though the pane's own workspace carries no delete state.
  it('waits while any other workspace removal is in flight', () => {
    expect(resolveWorktreeRemovalRespawnDecision({ 'wt-parent': { isDeleting: true } }, true)).toBe(
      'wait'
    )
  })

  it('respawns once every removal settled and the workspace survived', () => {
    expect(resolveWorktreeRemovalRespawnDecision({ 'wt-1': { isDeleting: false } }, true)).toBe(
      'respawn'
    )
    expect(resolveWorktreeRemovalRespawnDecision({}, true)).toBe('respawn')
    expect(resolveWorktreeRemovalRespawnDecision(undefined, true)).toBe('respawn')
  })

  it('abandons when the workspace is gone', () => {
    expect(resolveWorktreeRemovalRespawnDecision({}, false)).toBe('abandon')
  })
})

describe('isWorkspaceStillRegistered', () => {
  it('reads the visible worktree map', () => {
    const state = { worktreesByRepo: { repo1: [{ id: 'wt-1' }] } }
    expect(isWorkspaceStillRegistered(state, 'wt-1', null)).toBe(true)
    expect(isWorkspaceStillRegistered({ worktreesByRepo: { repo1: [] } }, 'wt-1', null)).toBe(false)
  })

  // Why: removeWorktree never prunes the on-disk detection scan, so a deleted
  // workspace lingers there. Respawning off that stale row would start a shell
  // in the directory the removal just deleted.
  it('ignores a stale on-disk detection row for a deleted workspace', () => {
    const state = {
      worktreesByRepo: { repo1: [] },
      detectedWorktreesByRepo: { repo1: { worktrees: [{ id: 'wt-1' }] } }
    }
    expect(isWorkspaceStillRegistered(state, 'wt-1', null)).toBe(false)
  })

  // Why: folder workspaces are synthesized on lookup and never live in
  // worktreesByRepo, so they must resolve through the folder list instead.
  it('resolves folder workspaces through folderWorkspaces', () => {
    const state = { worktreesByRepo: {}, folderWorkspaces: [{ id: 'folder-1' }] }
    expect(isWorkspaceStillRegistered(state, 'folder:folder-1', 'folder-1')).toBe(true)
    expect(isWorkspaceStillRegistered({ worktreesByRepo: {} }, 'folder:folder-1', 'folder-1')).toBe(
      false
    )
  })
})
