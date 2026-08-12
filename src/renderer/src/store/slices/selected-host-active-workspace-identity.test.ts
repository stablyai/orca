import { afterEach, describe, expect, it } from 'vitest'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { Worktree } from '../../../../shared/types'
import { getExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'
import { useAppStore } from '@/store'

const SAME_REPO_ID = 'same-repo'
const SAME_WORKTREE_ID = 'same-worktree'
const RUNTIME_HOST: ExecutionHostId = 'runtime:env-1'

function worktree(path: string, hostId: ExecutionHostId): Worktree {
  return {
    id: SAME_WORKTREE_ID,
    repoId: SAME_REPO_ID,
    path,
    displayName: path,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    head: 'abc',
    branch: 'refs/heads/main',
    isBare: false,
    isMainWorktree: true,
    hostId
  }
}

afterEach(() => {
  useAppStore.setState({
    repos: [],
    worktreesByRepo: {},
    detectedWorktreesByRepo: {},
    projectGroups: [],
    folderWorkspaces: [],
    activeRepoId: null,
    activeWorktreeId: null,
    activeWorkspaceKey: null,
    activeWorkspaceExecutionHostId: null
  } as never)
})

describe('selected-host active workspace identity', () => {
  it('selects the runtime worktree when exact IDs collide in local-first order', () => {
    const local = worktree('/local/repo', 'local')
    const runtime = worktree('/runtime/repo', RUNTIME_HOST)
    useAppStore.setState({
      repos: [
        {
          id: SAME_REPO_ID,
          path: local.path,
          displayName: 'local',
          badgeColor: '#000',
          addedAt: 1,
          executionHostId: 'local'
        },
        {
          id: SAME_REPO_ID,
          path: runtime.path,
          displayName: 'runtime',
          badgeColor: '#000',
          addedAt: 2,
          executionHostId: RUNTIME_HOST
        }
      ],
      worktreesByRepo: { [SAME_REPO_ID]: [local, runtime] },
      refreshGitHubForWorktreeIfStale: () => undefined
    })

    const selected = useAppStore.getState().getKnownWorktreeById(SAME_WORKTREE_ID, RUNTIME_HOST)
    expect(selected?.path).toBe(runtime.path)

    useAppStore.getState().setActiveWorktree(SAME_WORKTREE_ID, RUNTIME_HOST)
    const state = useAppStore.getState()
    expect(state.activeWorkspaceExecutionHostId).toBe(RUNTIME_HOST)
    expect(getExecutionHostIdForWorktree(state, SAME_WORKTREE_ID)).toBe(RUNTIME_HOST)
  })

  it('selects the runtime worktree when exact-ID catalog order is reversed', () => {
    const local = worktree('/local/repo', 'local')
    const runtime = worktree('/runtime/repo', RUNTIME_HOST)
    useAppStore.setState({
      repos: [
        {
          id: SAME_REPO_ID,
          path: runtime.path,
          displayName: 'runtime',
          badgeColor: '#000',
          addedAt: 1,
          executionHostId: RUNTIME_HOST
        },
        {
          id: SAME_REPO_ID,
          path: local.path,
          displayName: 'local',
          badgeColor: '#000',
          addedAt: 2,
          executionHostId: 'local'
        }
      ],
      worktreesByRepo: { [SAME_REPO_ID]: [runtime, local] }
    })

    expect(useAppStore.getState().getKnownWorktreeById(SAME_WORKTREE_ID, RUNTIME_HOST)?.path).toBe(
      runtime.path
    )
  })

  it('keeps exact-ID folder and group activation on the selected runtime', () => {
    useAppStore.setState({
      projectGroups: [
        {
          id: 'same-group',
          name: 'local',
          parentPath: '/local',
          executionHostId: 'local',
          parentGroupId: null,
          createdFrom: 'manual',
          tabOrder: 0,
          isCollapsed: false,
          color: null,
          createdAt: 1,
          updatedAt: 1
        },
        {
          id: 'same-group',
          name: 'runtime',
          parentPath: '/runtime',
          executionHostId: RUNTIME_HOST,
          parentGroupId: null,
          createdFrom: 'manual',
          tabOrder: 0,
          isCollapsed: false,
          color: null,
          createdAt: 1,
          updatedAt: 1
        }
      ],
      folderWorkspaces: [
        {
          id: 'same-folder',
          projectGroupId: 'same-group',
          name: 'local',
          folderPath: '/local/folder',
          executionHostId: 'local',
          linkedTask: null,
          comment: '',
          isArchived: false,
          isUnread: false,
          isPinned: false,
          sortOrder: 0,
          lastActivityAt: 0,
          createdAt: 1,
          updatedAt: 1
        },
        {
          id: 'same-folder',
          projectGroupId: 'same-group',
          name: 'runtime',
          folderPath: '/runtime/folder',
          executionHostId: RUNTIME_HOST,
          linkedTask: null,
          comment: '',
          isArchived: false,
          isUnread: false,
          isPinned: false,
          sortOrder: 0,
          lastActivityAt: 0,
          createdAt: 1,
          updatedAt: 1
        }
      ]
    })

    useAppStore.getState().setActiveFolderWorkspace('same-folder', RUNTIME_HOST)
    const state = useAppStore.getState()
    expect(state.activeWorkspaceExecutionHostId).toBe(RUNTIME_HOST)
    expect(getExecutionHostIdForWorktree(state, 'folder:same-folder')).toBe(RUNTIME_HOST)
  })
})
