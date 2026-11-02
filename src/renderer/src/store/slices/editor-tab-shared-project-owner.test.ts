import { describe, expect, it } from 'vitest'
import { createEditorTabsStore } from './editor-slice-test-harness'
import { makeWorktree, TEST_REPO } from './worktrees-slice-test-fixtures'
import { getDefaultSettings } from '../../../../shared/constants'

// #25467: a project set up on this machine and on a paired server shares one repo id.
function sharedProjectStore(worktreeHostId: 'local' | undefined, localRepoStamped: boolean) {
  const store = createEditorTabsStore()
  store.setState({
    repos: [
      {
        ...TEST_REPO,
        id: 'repo-1',
        path: '/local/repo',
        ...(localRepoStamped ? { executionHostId: 'local' as const } : {})
      },
      { ...TEST_REPO, id: 'repo-1', path: '/remote/repo', executionHostId: 'runtime:paired-mac' }
    ],
    worktreesByRepo: {
      'repo-1': [
        makeWorktree({
          id: 'repo-1::/local/repo-feature',
          repoId: 'repo-1',
          path: '/local/repo-feature',
          ...(worktreeHostId ? { hostId: worktreeHostId } : {})
        })
      ]
    },
    activeWorktreeId: 'repo-1::/local/repo-feature',
    activeWorkspaceExecutionHostId: worktreeHostId ?? null,
    // The paired server is the focused environment, as when it is the default for new projects.
    settings: { ...getDefaultSettings('/tmp/orca-test'), activeRuntimeEnvironmentId: 'paired-mac' },
    sshConnectionStates: new Map(),
    sshStateByEnvironment: new Map()
  })
  return store
}

describe('editor tabs of a local worktree in a project shared with a paired host', () => {
  it.each([
    { hostId: 'local' as const, localRepoStamped: true },
    { hostId: undefined, localRepoStamped: true },
    { hostId: undefined, localRepoStamped: false }
  ])(
    'binds to this machine, not the focused paired host (worktree host $hostId, local repo stamped $localRepoStamped)',
    ({ hostId, localRepoStamped }) => {
      const store = sharedProjectStore(hostId, localRepoStamped)
      store.getState().openFile({
        filePath: '/local/repo-feature/file.ts',
        relativePath: 'file.ts',
        worktreeId: 'repo-1::/local/repo-feature',
        language: 'typescript',
        mode: 'edit'
      })
      const file = store.getState().openFiles[0]
      expect(file?.runtimeEnvironmentId ?? null).toBeNull()
      expect(file?.operationProvenance?.generation.route).toEqual({
        executionHostId: 'local',
        runtimeEnvironmentId: null
      })
      expect(file?.id).not.toContain('paired-mac')
    }
  )
})

describe('an editor tab already bound to a host that does not know its workspace', () => {
  it('still closes', () => {
    const store = sharedProjectStore(undefined, true)
    store.getState().openFile({
      filePath: '/local/repo-feature/file.ts',
      relativePath: 'file.ts',
      worktreeId: 'repo-1::/local/repo-feature',
      language: 'typescript',
      mode: 'edit',
      runtimeEnvironmentId: 'stale-local-runtime'
    })
    const file = store.getState().openFiles[0]
    expect(file?.runtimeEnvironmentId).toBe('stale-local-runtime')
    store.getState().closeFile(file!.id)
    expect(store.getState().openFiles).toEqual([])
    expect(
      (store.getState().unifiedTabsByWorktree['repo-1::/local/repo-feature'] ?? []).filter(
        (tab) => tab.contentType === 'editor'
      )
    ).toEqual([])
  })
})
