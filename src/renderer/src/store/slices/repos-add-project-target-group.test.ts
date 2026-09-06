import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestStore } from './store-test-helpers'
import { upsertAddedRepoWithProjectHostSetup } from '../../components/sidebar/add-repo-store-upsert'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import type { Repo } from '../../../../shared/repo-types'
import { LOCAL_EXECUTION_HOST_ID, toSshExecutionHostId } from '../../../../shared/execution-host'
import {
  addProjectTargetForGroup,
  type AddProjectTarget
} from '../../lib/added-project-group-assignment'
import {
  installReposRuntimeRoutingHarness,
  projectGroupsMoveProject,
  reposAdd
} from './repos-runtime-routing-fixture'

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn(), warning: vi.fn() }
}))

installReposRuntimeRoutingHarness()

const LOCAL_TARGET: AddProjectTarget = { groupId: 'group-1', hostId: LOCAL_EXECUTION_HOST_ID }

const projectGroup: ProjectGroup = {
  id: 'group-1',
  name: 'OSS',
  parentPath: null,
  connectionId: null,
  executionHostId: null,
  parentGroupId: null,
  createdFrom: 'manual',
  tabOrder: 0,
  isCollapsed: false,
  color: null,
  createdAt: 1,
  updatedAt: 1
}

const addedRepo: Repo = {
  id: 'repo-1',
  path: '/tmp/orca',
  displayName: 'orca',
  badgeColor: '#111',
  addedAt: 2
}

beforeEach(() => {
  reposAdd.mockResolvedValue({ repo: addedRepo })
  projectGroupsMoveProject.mockImplementation(({ groupId }: { groupId: string | null }) => ({
    ...addedRepo,
    projectGroupId: groupId
  }))
})

// Why: the assignment is fire-and-forget; advance a few ticks so a move that would fire has
// fired before asserting it did not.
async function flushAssignment(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

// Why: the add-project entry points split across two funnels — the repo slice's addRepoPath
// and the dialog-side upsert helper. A target group has to survive both.
describe('add project into a target group', () => {
  it('assigns a project added through addRepoPath', async () => {
    const store = createTestStore()
    store.setState({ projectGroups: [projectGroup], addProjectTarget: LOCAL_TARGET })

    await store.getState().addRepoPath('/tmp/orca')
    // Why: the move lands after addRepoPath resolves, so poll rather than assert straight through.
    await vi.waitFor(() => expect(projectGroupsMoveProject).toHaveBeenCalled())

    expect(projectGroupsMoveProject).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'repo-1', groupId: 'group-1' })
    )
  })

  // Why: the project is already persisted when addRepoPath returns; waiting on the group move
  // would expose moveProjectToGroup's remote timeout to every caller.
  it('returns from addRepoPath without waiting for the group move', async () => {
    const store = createTestStore()
    let releaseMove = (): void => {}
    projectGroupsMoveProject.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseMove = () => resolve({ ...addedRepo, projectGroupId: 'group-1' })
        })
    )
    store.setState({ projectGroups: [projectGroup], addProjectTarget: LOCAL_TARGET })

    await expect(store.getState().addRepoPath('/tmp/orca')).resolves.toBeTruthy()

    releaseMove()
  })

  it('assigns a project added through the dialog upsert helper', async () => {
    // Why: the helper reads the app store singleton rather than an injected store.
    const { useAppStore } = await import('../index')
    useAppStore.setState({
      repos: [],
      projectGroups: [projectGroup],
      addProjectTarget: LOCAL_TARGET
    })

    upsertAddedRepoWithProjectHostSetup(addedRepo)
    await vi.waitFor(() => expect(projectGroupsMoveProject).toHaveBeenCalled())

    expect(projectGroupsMoveProject).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'repo-1', groupId: 'group-1' })
    )
  })

  it('leaves an add with no target ungrouped', async () => {
    const store = createTestStore()
    store.setState({ projectGroups: [projectGroup], addProjectTarget: null })

    await store.getState().addRepoPath('/tmp/orca')
    await flushAssignment()

    expect(projectGroupsMoveProject).not.toHaveBeenCalled()
  })

  // Why: picking a folder that is already a project is still an explicit request to put it in
  // this group, so it gets grouped rather than being a no-op the user cannot explain.
  it('groups a re-added project that had no group', async () => {
    const store = createTestStore()
    store.setState({
      repos: [addedRepo],
      projectGroups: [projectGroup],
      addProjectTarget: LOCAL_TARGET
    })

    await store.getState().addRepoPath('/tmp/orca')
    await vi.waitFor(() => expect(projectGroupsMoveProject).toHaveBeenCalled())

    expect(projectGroupsMoveProject).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'repo-1', groupId: 'group-1' })
    )
  })

  // Why: the counterpart — an existing group is the user's earlier decision and outranks this one.
  it('leaves a re-added project in the group it already had', async () => {
    const store = createTestStore()
    const groupedRepo = { ...addedRepo, projectGroupId: 'group-other' }
    reposAdd.mockResolvedValue({ repo: groupedRepo })
    store.setState({
      repos: [groupedRepo],
      projectGroups: [projectGroup],
      addProjectTarget: LOCAL_TARGET
    })

    await store.getState().addRepoPath('/tmp/orca')
    await flushAssignment()

    expect(projectGroupsMoveProject).not.toHaveBeenCalled()
    expect(store.getState().repos.find((repo) => repo.id === 'repo-1')?.projectGroupId).toBe(
      'group-other'
    )
  })

  // Why: one Add Project flow places one project; a later unrelated add must not inherit it.
  it('does not reuse the target for a second add', async () => {
    const store = createTestStore()
    store.setState({ projectGroups: [projectGroup], addProjectTarget: LOCAL_TARGET })

    await store.getState().addRepoPath('/tmp/orca')
    await vi.waitFor(() => expect(projectGroupsMoveProject).toHaveBeenCalled())
    projectGroupsMoveProject.mockClear()
    reposAdd.mockResolvedValue({ repo: { ...addedRepo, id: 'repo-2', path: '/tmp/other' } })
    await store.getState().addRepoPath('/tmp/other')
    await flushAssignment()

    expect(projectGroupsMoveProject).not.toHaveBeenCalled()
  })

  // Why: a non-git path swaps add-repo for the confirm dialog; openModal only keeps a target the
  // opener re-declares, so the handoff has to carry it or the folder lands ungrouped.
  it('carries the target across the non-git folder confirmation handoff', async () => {
    const store = createTestStore()
    reposAdd.mockResolvedValue({ error: 'Not a valid git repository: /tmp/orca' })
    store.getState().openModal('add-repo', { addProjectTarget: LOCAL_TARGET })
    store.setState({ projectGroups: [projectGroup] })

    await expect(store.getState().addRepoPath('/tmp/orca')).resolves.toBeNull()

    expect(store.getState().activeModal).toBe('confirm-non-git-folder')
    expect(store.getState().addProjectTarget).toEqual(LOCAL_TARGET)
  })
})

describe('add project into a target group around the dialog boundary', () => {
  it('arms the target the group header hands to openModal', () => {
    const store = createTestStore()

    store
      .getState()
      .openModal('add-repo', { addProjectTarget: addProjectTargetForGroup(projectGroup) })

    expect(store.getState().activeModal).toBe('add-repo')
    expect(store.getState().addProjectTarget).toEqual(LOCAL_TARGET)
  })

  // Why: NonGitFolderDialog starts the add and closes at once, which nulls the store target
  // before the add can read it — so the dialog hands the target down the call instead.
  it('groups a folder confirmed after the dialog closed', async () => {
    const store = createTestStore()
    reposAdd.mockResolvedValue({ repo: { ...addedRepo, kind: 'folder' } })
    store.setState({ projectGroups: [projectGroup] })
    store.getState().openModal('confirm-non-git-folder', {
      folderPath: '/tmp/orca',
      addProjectTarget: LOCAL_TARGET
    })
    const addProjectTarget = store.getState().addProjectTarget

    const pending = store.getState().addRepoPath('/tmp/orca', 'folder', { addProjectTarget })
    store.getState().closeModal()
    await pending

    await vi.waitFor(() =>
      expect(projectGroupsMoveProject).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: 'repo-1', groupId: 'group-1' })
      )
    )
  })

  it('leaves a re-added project the upsert helper receives already grouped where it is', async () => {
    const { useAppStore } = await import('../index')
    const groupedRepo = { ...addedRepo, projectGroupId: 'group-other' }
    useAppStore.setState({
      repos: [groupedRepo],
      projectGroups: [projectGroup],
      addProjectTarget: LOCAL_TARGET
    })

    upsertAddedRepoWithProjectHostSetup(groupedRepo)
    await flushAssignment()

    expect(projectGroupsMoveProject).not.toHaveBeenCalled()
    expect(useAppStore.getState().repos.find((repo) => repo.id === 'repo-1')?.projectGroupId).toBe(
      'group-other'
    )
  })

  it('assigns an SSH-hosted project added through the upsert helper to its SSH group', async () => {
    const { useAppStore } = await import('../index')
    const sshGroup: ProjectGroup = { ...projectGroup, connectionId: 'ssh-1' }
    const sshRepo: Repo = { ...addedRepo, connectionId: 'ssh-1' }
    projectGroupsMoveProject.mockImplementation(({ groupId }: { groupId: string | null }) => ({
      ...sshRepo,
      projectGroupId: groupId
    }))
    useAppStore.setState({
      repos: [],
      projectGroups: [sshGroup],
      addProjectTarget: { groupId: 'group-1', hostId: toSshExecutionHostId('ssh-1') }
    })

    upsertAddedRepoWithProjectHostSetup(sshRepo, { sshConnectionId: 'ssh-1' })
    await vi.waitFor(() => expect(projectGroupsMoveProject).toHaveBeenCalled())

    expect(projectGroupsMoveProject).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'repo-1', groupId: 'group-1' })
    )
  })
})
