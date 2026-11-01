import { describe, expect, it } from 'vitest'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import {
  createNativeChatRuntimeSelector,
  selectNativeChatRuntimeEnvironmentId,
  type NativeChatRuntimeOwnerState
} from './native-chat-runtime-owner'

function tab(id: string): TerminalTab {
  return {
    id,
    ptyId: null,
    worktreeId: 'owner',
    title: id,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

function state(): NativeChatRuntimeOwnerState {
  return {
    tabsByWorktree: { owner: [tab('target')] },
    worktreesByRepo: { repo: [{ id: 'owner', repoId: 'repo', hostId: 'runtime:first' }] }
  }
}

describe('createNativeChatRuntimeSelector', () => {
  it('does not inspect terminal rows during unrelated publications and keeps runtime routing fresh', () => {
    const initial = state()
    const target = initial.tabsByWorktree.owner?.[0]
    if (!target) {
      throw new Error('Expected the target tab fixture')
    }
    let reads = 0
    Object.defineProperty(target, 'id', {
      get: () => {
        reads++
        return 'target'
      }
    })
    const select = createNativeChatRuntimeSelector('target')
    expect(select(initial)).toBe('first')
    expect(reads).toBe(1)
    for (let i = 0; i < 100; i++) {
      const next: NativeChatRuntimeOwnerState = {
        ...initial,
        worktreesByRepo: { repo: [{ id: 'owner', repoId: 'repo', hostId: `runtime:next-${i}` }] }
      }
      expect(select(next)).toBe(`next-${i}`)
    }
    expect(reads).toBe(1)
    expect(select({ ...initial, tabsByWorktree: { ...initial.tabsByWorktree } })).toBe('first')
    expect(reads).toBe(2)
  })

  it('preserves first terminal owner, move, close, and independent tab identities', () => {
    const initial = state()
    const withCollision: NativeChatRuntimeOwnerState = {
      ...initial,
      tabsByWorktree: { ...initial.tabsByWorktree, later: [tab('target'), tab('second')] },
      worktreesByRepo: {
        repo: [
          ...(initial.worktreesByRepo?.repo ?? []),
          { id: 'later', repoId: 'repo', hostId: 'runtime:later' }
        ]
      }
    }
    const select = createNativeChatRuntimeSelector('target')
    const selectSecond = createNativeChatRuntimeSelector('second')
    for (const next of [
      initial,
      withCollision,
      { ...withCollision, tabsByWorktree: { later: [tab('target'), tab('second')] } },
      { ...withCollision, tabsByWorktree: {} }
    ]) {
      expect(select(next)).toBe(selectNativeChatRuntimeEnvironmentId(next, 'target'))
      expect(selectSecond(next)).toBe(selectNativeChatRuntimeEnvironmentId(next, 'second'))
    }
  })

  it('ignores structured-only tabs and refreshes active, detected, folder, and repo host projections', () => {
    const select = createNativeChatRuntimeSelector('target')
    const initial = state()
    const missing = {
      ...initial,
      tabsByWorktree: {},
      unifiedTabsByWorktree: { owner: [{ id: 'target', contentType: 'agent-session' }] }
    }
    expect(select(missing)).toBeNull()
    const projections: NativeChatRuntimeOwnerState[] = [
      initial,
      {
        ...initial,
        activeWorktreeId: 'owner',
        activeWorkspaceExecutionHostId: 'runtime:active' as const
      },
      {
        ...initial,
        detectedWorktreesByRepo: {
          repo: { worktrees: [{ id: 'owner', repoId: 'repo', hostId: 'runtime:detected' }] }
        }
      },
      {
        ...initial,
        worktreesByRepo: { repo: [{ id: 'owner', repoId: 'repo' }] },
        repos: [{ id: 'repo', executionHostId: 'ssh:remote' as const }]
      },
      {
        ...initial,
        tabsByWorktree: { 'folder:scope': [tab('target')] },
        folderWorkspaces: [
          { id: 'scope', projectGroupId: 'group', executionHostId: 'runtime:folder' as const }
        ]
      }
    ]
    for (const next of projections) {
      expect(select(next)).toBe(selectNativeChatRuntimeEnvironmentId(next, 'target'))
    }
  })
})
