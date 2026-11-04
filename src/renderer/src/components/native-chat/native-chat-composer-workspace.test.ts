import { describe, expect, it } from 'vitest'
import { createTestStore } from '@/store/slices/store-test-helpers'
import {
  makeWorktree,
  makeFolderWorkspace,
  TEST_REPO
} from '@/store/slices/worktrees-slice-test-fixtures'
import { makeTab, makeUnifiedTab } from '@/store/slices/store-session-test-harness'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import { createNativeChatComposerWorkspaceSelector } from './native-chat-composer-workspace'

describe('composer workspace context', () => {
  it('preserves a terminal chat SSH host even when a local twin is selected', () => {
    const store = createTestStore()
    store.setState({
      repos: [TEST_REPO, { ...TEST_REPO, executionHostId: 'ssh:box' }],
      activeWorktreeId: 'wt-1',
      activeWorkspaceExecutionHostId: 'local',
      worktreesByRepo: {
        [TEST_REPO.id]: [
          makeWorktree({ id: 'wt-1', repoId: TEST_REPO.id, hostId: 'local', branch: 'local' }),
          makeWorktree({
            id: 'wt-1',
            repoId: TEST_REPO.id,
            hostId: 'ssh:box',
            branch: 'ssh',
            path: '/srv/work'
          })
        ]
      },
      tabsByWorktree: {
        'wt-1': [makeTab({ id: 'chat', worktreeId: 'wt-1' })]
      },
      unifiedTabsByWorktree: {
        'wt-1': [
          makeUnifiedTab({
            id: 'chat',
            worktreeId: 'wt-1',
            groupId: 'group',
            executionHostId: 'ssh:box'
          })
        ]
      }
    })
    expect(createNativeChatComposerWorkspaceSelector('chat')(store.getState())).toMatchObject({
      branch: 'ssh',
      path: '/srv/work'
    })
  })

  it('uses this floating session pin and waits through missing or stale pins', () => {
    const store = createTestStore()
    const worktreeId = FLOATING_TERMINAL_WORKTREE_ID
    store.setState({
      floatingWorkspacePath: '/home/me/changed-setting',
      unifiedTabsByWorktree: {
        [worktreeId]: [
          makeUnifiedTab({
            id: 'chat',
            worktreeId,
            groupId: 'group',
            entityId: 'session-1',
            contentType: 'agent-session',
            agentSessionAgent: 'codex'
          })
        ]
      },
      structuredSessionLaunchDirectoryByTabId: {}
    })
    const select = createNativeChatComposerWorkspaceSelector('chat', {
      worktreeId,
      runtimeEnvironmentId: null
    })
    expect(select(store.getState()).path).toBeUndefined()
    store.setState({
      structuredSessionLaunchDirectoryByTabId: {
        chat: { sessionId: 'old-session', launchDirectory: '/home/me/stale' }
      }
    })
    expect(select(store.getState()).path).toBeUndefined()
    store.setState({
      structuredSessionLaunchDirectoryByTabId: {
        chat: { sessionId: 'session-1', launchDirectory: '/home/me/pinned' }
      }
    })
    expect(select(store.getState())).toMatchObject({ path: '/home/me/pinned', branch: '' })
    store.setState({ floatingWorkspacePath: '/home/me/another-setting' })
    expect(select(store.getState()).path).toBe('/home/me/pinned')
    store.setState({
      unifiedTabsByWorktree: {
        [worktreeId]: [
          makeUnifiedTab({
            id: 'chat',
            worktreeId,
            groupId: 'group',
            entityId: 'session-2',
            contentType: 'agent-session',
            agentSessionAgent: 'codex'
          })
        ]
      }
    })
    expect(select(store.getState()).path).toBeUndefined()
  })

  it.each([8, 80])(
    'caches missing-folder resolution before catalog scans for %i retained consumers',
    (size) => {
      const store = createTestStore()
      let visits = 0
      const folders = Array.from({ length: size }, (_, index) => {
        const id = `existing-${index}`
        const folder = makeFolderWorkspace({ id, executionHostId: 'local' })
        Object.defineProperty(folder, 'id', {
          get: () => {
            visits++
            return id
          }
        })
        return folder
      })
      store.setState({ folderWorkspaces: folders })
      const selectors = Array.from({ length: size }, (_, index) =>
        createNativeChatComposerWorkspaceSelector(`chat-${index}`, {
          worktreeId: `folder:missing-${index}`,
          runtimeEnvironmentId: null
        })
      )
      const read = () => selectors.map((select) => select(store.getState()))
      const first = read()
      expect(visits).toBeGreaterThan(0)
      visits = 0
      store.setState({
        activeWorktreeId: 'unrelated',
        activeWorkspaceExecutionHostId: 'runtime:box'
      })
      read().forEach((value, index) => expect(value).toBe(first[index]))
      expect(visits).toBe(0)
      store.setState({
        folderWorkspaces: [
          ...folders,
          makeFolderWorkspace({ id: 'missing-0', folderPath: '/arrived', executionHostId: 'local' })
        ]
      })
      expect(read()[0]).toMatchObject({ path: '/arrived' })
      expect(visits).toBeGreaterThan(0)
    }
  )
})
