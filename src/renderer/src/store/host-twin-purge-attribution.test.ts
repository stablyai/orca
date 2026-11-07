import { describe, expect, it } from 'vitest'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { hostWorktreeTarget } from '../../../shared/worktree/host-qualified-identity'
import { buildWorktreePurgeState } from './slices/worktrees/teardown/worktree-purge-state'
import {
  createTestStore,
  makeOpenFile,
  makeUnifiedTab,
  makeWorktree
} from './slices/store-test-helpers'

const workspace = 'repo1::/synthetic/workspace'

describe('host twin purge attribution', () => {
  it('keeps exact tracked publisher precedence over duplicate and detected transport aliases', () => {
    const state = createTestStore().getState()
    const tracked = ['primary', 'duplicate'].map((runtimeOwnerEnvironmentId) => {
      const row = makeWorktree({
        id: workspace,
        repoId: 'repo1',
        hostId: 'ssh:removed',
        runtimeOwnerEnvironmentId
      })
      return row
    })
    state.worktreesByRepo = {
      repo1: [...tracked, makeWorktree({ id: workspace, repoId: 'repo1', hostId: 'local' })]
    }
    const detected = (runtimeOwnerEnvironmentId: string) => ({
      ...makeWorktree({
        id: workspace,
        repoId: 'repo1',
        hostId: 'ssh:removed',
        runtimeOwnerEnvironmentId
      }),
      ownership: 'orca-managed' as const,
      selectedCheckout: false,
      visible: true
    })
    state.detectedWorktreesByRepo = {
      repo1: {
        repoId: 'repo1',
        authoritative: true,
        source: 'session-fallback',
        worktrees: [detected('detected')]
      },
      rival: {
        repoId: 'rival',
        authoritative: true,
        source: 'session-fallback',
        worktrees: [{ ...detected('primary'), hostId: 'runtime:primary' }]
      }
    }
    state.unifiedTabsByWorktree = {
      [workspace]: ['primary', 'duplicate', 'detected'].map((alias) =>
        makeUnifiedTab({
          id: alias,
          worktreeId: workspace,
          groupId: 'group',
          executionHostId: `runtime:${alias}`
        })
      )
    }
    const patch = buildWorktreePurgeState(state, [
      hostWorktreeTarget({ id: workspace, hostId: 'ssh:removed' })
    ])
    expect(patch.unifiedTabsByWorktree?.[workspace]?.map((tab) => tab.id)).toEqual([
      'duplicate',
      'detected'
    ])
  })

  it('refreshes global file membership after an earlier host closes a file', () => {
    const state = createTestStore().getState()
    const second = 'repo1::/synthetic/second'
    const publications: [string, ExecutionHostId][] = [
      [workspace, 'runtime:first'],
      [workspace, 'runtime:survivor'],
      [second, 'runtime:second'],
      [second, 'runtime:survivor']
    ]
    state.worktreesByRepo = {
      repo1: publications.map(([id, hostId]) => {
        const row = makeWorktree({ id, repoId: 'repo1', hostId })

        return row
      })
    }
    state.openFiles = [
      makeOpenFile({ id: 'shared-view', worktreeId: workspace, runtimeEnvironmentId: 'first' })
    ]
    state.unifiedTabsByWorktree = {
      [workspace]: [
        makeUnifiedTab({
          id: 'first-view',
          entityId: 'shared-view',
          contentType: 'editor',
          worktreeId: workspace,
          groupId: 'group',
          executionHostId: 'runtime:first'
        })
      ],
      [second]: [
        makeUnifiedTab({
          id: 'stale-second-view',
          entityId: 'shared-view',
          contentType: 'editor',
          worktreeId: second,
          groupId: 'group',
          executionHostId: 'runtime:second'
        }),
        makeUnifiedTab({
          id: 'surviving-terminal',
          worktreeId: second,
          groupId: 'group',
          executionHostId: 'runtime:survivor'
        })
      ]
    }
    const patch = buildWorktreePurgeState(state, [
      hostWorktreeTarget({ id: workspace, hostId: 'runtime:first' }),
      hostWorktreeTarget({ id: second, hostId: 'runtime:second' })
    ])
    expect(patch.openFiles).toEqual([])
    expect(patch.unifiedTabsByWorktree?.[second]?.map((tab) => tab.id)).toEqual([
      'surviving-terminal'
    ])
  })
  it('attributes a decoded runtime target to its physical SSH publisher', () => {
    const state = createTestStore().getState()
    state.worktreesByRepo = {
      repo1: [
        makeWorktree({
          id: workspace,
          repoId: 'repo1',
          hostId: 'ssh:removed',
          runtimeOwnerEnvironmentId: 'prod/server'
        }),
        makeWorktree({ id: workspace, repoId: 'repo1', hostId: 'local' })
      ]
    }
    state.unifiedTabsByWorktree = {
      [workspace]: [
        makeUnifiedTab({
          id: 'removed-terminal',
          worktreeId: workspace,
          groupId: 'group',
          executionHostId: 'ssh:removed'
        }),
        makeUnifiedTab({
          id: 'surviving-terminal',
          worktreeId: workspace,
          groupId: 'group',
          executionHostId: 'local'
        })
      ]
    }
    const patch = buildWorktreePurgeState(state, [
      hostWorktreeTarget({ id: workspace, hostId: 'runtime:prod%2fserver' })
    ])
    expect(patch.unifiedTabsByWorktree?.[workspace]?.map((tab) => tab.id)).toEqual([
      'surviving-terminal'
    ])
  })
})
