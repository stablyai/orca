// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { Repo } from '../../../../../../shared/repo-types'
import type { ProjectHostSetup } from '../../../../../../shared/project-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { useAppStore } from '@/store'
import { makeWorktree, TEST_REPO } from '@/store/slices/worktrees-slice-test-fixtures'
import { useWorktreeContextMenuCommands } from './use-worktree-context-menu-commands'

afterEach(() => {
  cleanup()
  useAppStore.setState(useAppStore.getInitialState(), true)
})

const localRepo: Repo = { ...TEST_REPO, id: 'project' }
const serverRepo: Repo = {
  ...localRepo,
  executionHostId: 'runtime:server-a',
  connectionId: 'builder'
}
const otherServerRepo: Repo = { ...serverRepo, executionHostId: 'runtime:server-b' }
const directSshRepo: Repo = { ...localRepo, connectionId: 'builder' }

function runNewChildWorktree(args: {
  worktree?: Partial<Worktree>
  repos: Repo[]
  activeRepo: Repo
  projectHostSetups?: ProjectHostSetup[]
}) {
  useAppStore.setState({
    repos: args.repos,
    projectHostSetups: args.projectHostSetups ?? [],
    activeRepoId: args.activeRepo.id,
    activeWorkspaceExecutionHostId: args.activeRepo.executionHostId ?? null
  })
  const state = useAppStore.getState()
  const { result } = renderHook(() =>
    useWorktreeContextMenuCommands({
      worktree: makeWorktree({ id: 'project::/parent', repoId: 'project', ...args.worktree }),
      repo: args.activeRepo,
      getState: useAppStore.getState,
      openModal: state.openModal,
      setMenuOpenState: () => {},
      folderWorkspaceId: null,
      activeContextWorktrees: [],
      batchDeleteWorktrees: [],
      createGroupDialogActiveRef: { current: false },
      createProjectGroup: state.createProjectGroup,
      isMultiContext: false,
      moveProjectToGroup: state.moveProjectToGroup,
      scopeRef: { current: null },
      setCreateGroupDialogOpen: () => {},
      setWorkspaceUnreadByUser: state.setWorkspaceUnreadByUser,
      setWorktreesPinnedAndReveal: state.setWorktreesPinnedAndReveal,
      sleepableWorktrees: [],
      subtreeSleepableWorktrees: [],
      updateWorktreeMeta: state.updateWorktreeMeta,
      validParentWorktreeId: null,
      statusesForWorktree: () => []
    })
  )
  act(() => result.current.handleNewChildWorktree())
  const { activeModal, modalData } = useAppStore.getState()
  return { activeModal, modalData, canCreateChildWorktree: result.current.canCreateChildWorktree }
}

describe('New Child Worktree ownership', () => {
  it('opens on the implicit local parent while a remote workspace is active', () => {
    const modal = runNewChildWorktree({
      repos: [serverRepo, localRepo],
      activeRepo: serverRepo
    })

    expect(modal).toEqual({
      canCreateChildWorktree: true,
      activeModal: 'new-workspace-composer',
      modalData: {
        initialRepoId: 'project',
        initialWorkspaceTarget: { projectId: 'repo:project', hostId: 'local' },
        initialParentWorktreeId: 'project::/parent',
        telemetrySource: 'sidebar'
      }
    })
  })

  it('opens through the clicked nested SSH parent’s runtime owner', () => {
    const modal = runNewChildWorktree({
      worktree: { hostId: 'ssh:builder', runtimeOwnerEnvironmentId: 'server-a' },
      repos: [otherServerRepo, directSshRepo, serverRepo],
      activeRepo: otherServerRepo,
      projectHostSetups: [
        {
          id: 'server-a-setup',
          projectId: 'project',
          repoId: 'project',
          hostId: 'runtime:server-a',
          path: '/project',
          displayName: 'Project',
          setupState: 'ready',
          setupMethod: 'legacy-repo',
          createdAt: 1,
          updatedAt: 1
        }
      ]
    })

    expect(modal).toEqual({
      canCreateChildWorktree: true,
      activeModal: 'new-workspace-composer',
      modalData: {
        initialRepoId: 'project',
        initialWorkspaceTarget: {
          projectId: 'project',
          hostId: 'runtime:server-a',
          projectHostSetupId: 'server-a-setup'
        },
        initialParentWorktreeId: 'project::/parent',
        telemetrySource: 'sidebar'
      }
    })
  })

  it.each([
    { name: 'another host', worktree: {}, repo: serverRepo },
    { name: 'another repository', worktree: {}, repo: { ...localRepo, id: 'other' } },
    {
      name: 'a direct SSH connection',
      worktree: { hostId: 'ssh:builder', runtimeOwnerEnvironmentId: 'server-a' },
      repo: directSshRepo
    },
    {
      name: 'another nested SSH target',
      worktree: { hostId: 'ssh:builder', runtimeOwnerEnvironmentId: 'server-a' },
      repo: { ...serverRepo, connectionId: 'other-builder' }
    }
  ] satisfies { name: string; worktree: Partial<Worktree>; repo: Repo }[])(
    'refuses to fall back to $name when the parent repository is unavailable',
    ({ worktree, repo }) => {
      const modal = runNewChildWorktree({ worktree, repos: [repo], activeRepo: repo })

      expect(modal).toEqual({
        canCreateChildWorktree: false,
        activeModal: 'none',
        modalData: {}
      })
    }
  )
})
