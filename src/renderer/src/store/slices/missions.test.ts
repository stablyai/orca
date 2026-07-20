import { beforeEach, describe, expect, it, vi } from 'vitest'
import { create, type StateCreator } from 'zustand'
import { createMissionsSlice, missionMemberErrorKey, type MissionsSlice } from './missions'
import type { FolderWorkspace, Mission, MissionCreateResult } from '../../../../shared/types'

const missionsApi = {
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  addMembers: vi.fn(),
  removeMember: vi.fn(),
  recreateMemberWorktree: vi.fn(),
  ensureSession: vi.fn()
}

vi.stubGlobal('window', {
  api: { missions: missionsApi }
})

type TestState = MissionsSlice & {
  folderWorkspaces: FolderWorkspace[]
  fetchFolderWorkspaces: ReturnType<typeof vi.fn>
  purgeWorktreeTerminalState: ReturnType<typeof vi.fn>
}

function makeStore(folderWorkspaces: FolderWorkspace[] = []) {
  const createSlice = createMissionsSlice as unknown as StateCreator<
    TestState,
    [],
    [],
    MissionsSlice
  >
  return create<TestState>()((...args) => ({
    ...createSlice(...args),
    folderWorkspaces,
    fetchFolderWorkspaces: vi.fn(async () => {}),
    purgeWorktreeTerminalState: vi.fn()
  }))
}

const mission: Mission = {
  id: 'm1',
  name: 'Referral',
  branchName: 'mission/referral',
  members: [
    {
      repoId: 'r1',
      worktreeId: 'r1::/wt',
      worktreeInstanceId: 'instance-r1',
      lastError: null,
      addedAt: 1
    },
    {
      repoId: 'r2',
      worktreeId: null,
      worktreeInstanceId: null,
      lastError: null,
      addedAt: 1
    }
  ],
  tabOrder: 0,
  createdAt: 1,
  updatedAt: 1
}

const missionWithDurableError: Mission = {
  ...mission,
  members: mission.members.map((member) =>
    member.repoId === 'r2' ? { ...member, lastError: 'Branch already exists' } : { ...member }
  )
}

const missionWorkspace = {
  id: 'fw-1',
  missionId: 'm1'
} as FolderWorkspace

beforeEach(() => {
  vi.clearAllMocks()
})

describe('missions slice', () => {
  it('fetchMissions stores missions and rebuilds errors from durable member state', async () => {
    missionsApi.list.mockResolvedValue([missionWithDurableError])
    const store = makeStore()

    await store.getState().fetchMissions()

    expect(store.getState().missions).toEqual([missionWithDurableError])
    expect(store.getState().missionMemberErrors).toEqual({
      [missionMemberErrorKey('m1', 'r2')]: 'Branch already exists'
    })
  })

  it('createMission keeps the result error after refreshing durable mission state', async () => {
    const result: MissionCreateResult = {
      mission: missionWithDurableError,
      memberResults: [
        {
          repoId: 'r1',
          worktreeId: 'r1::/wt',
          worktreeInstanceId: 'instance-r1'
        },
        { repoId: 'r2', worktreeId: null, error: 'Branch already exists' }
      ]
    }
    missionsApi.create.mockResolvedValue(result)
    missionsApi.list.mockResolvedValue([missionWithDurableError])
    const store = makeStore()

    const created = await store
      .getState()
      .createMission({ name: 'Referral', repoIds: ['r1', 'r2'] })

    expect(created).toEqual(result)
    expect(store.getState().missionMemberErrors[missionMemberErrorKey('m1', 'r2')]).toBe(
      'Branch already exists'
    )
    expect(store.getState().missions).toEqual([missionWithDurableError])
  })

  it('ensureMissionSession refreshes folder workspaces before mission state', async () => {
    const workspace = { id: 'fw-1', missionId: 'm1' }
    missionsApi.ensureSession.mockResolvedValue(workspace)
    missionsApi.list.mockResolvedValue([mission])
    const store = makeStore()

    const result = await store.getState().ensureMissionSession('m1')

    expect(result).toEqual(workspace)
    expect(missionsApi.ensureSession).toHaveBeenCalledWith({ missionId: 'm1' })
    expect(store.getState().fetchFolderWorkspaces).toHaveBeenCalledOnce()
    expect(store.getState().fetchFolderWorkspaces.mock.invocationCallOrder[0]).toBeLessThan(
      missionsApi.list.mock.invocationCallOrder[0]
    )
  })

  it('deleteMission purges the mission session and refreshes both collections on deletion', async () => {
    missionsApi.delete.mockResolvedValue({ deleted: true, memberResults: [] })
    missionsApi.list.mockResolvedValue([])
    const store = makeStore([missionWorkspace])
    store.getState().fetchFolderWorkspaces.mockImplementation(async () => {
      store.setState({ folderWorkspaces: [] })
    })

    const result = await store.getState().deleteMission('m1', true)

    expect(result).toEqual({ deleted: true, memberResults: [] })
    expect(missionsApi.delete).toHaveBeenCalledWith({ missionId: 'm1', deleteWorktrees: true })
    expect(store.getState().purgeWorktreeTerminalState).toHaveBeenCalledWith(['folder:fw-1'])
    expect(store.getState().fetchFolderWorkspaces).toHaveBeenCalledOnce()
    expect(missionsApi.list).toHaveBeenCalledOnce()
  })

  it('deleteMission preserves terminal state until the session workspace is absent after refresh', async () => {
    missionsApi.delete.mockResolvedValue({ deleted: true, memberResults: [] })
    missionsApi.list.mockResolvedValue([])
    const store = makeStore([missionWorkspace])

    await store.getState().deleteMission('m1', true)

    expect(store.getState().fetchFolderWorkspaces).toHaveBeenCalledOnce()
    expect(store.getState().purgeWorktreeTerminalState).not.toHaveBeenCalled()
  })

  it('deleteMission preserves renderer session state when main teardown fails', async () => {
    missionsApi.delete.mockResolvedValue({
      deleted: false,
      memberResults: [],
      error: 'session teardown failed'
    })
    missionsApi.list.mockResolvedValue([mission])
    const store = makeStore([missionWorkspace])

    await store.getState().deleteMission('m1', false)

    expect(store.getState().purgeWorktreeTerminalState).not.toHaveBeenCalled()
    expect(store.getState().fetchFolderWorkspaces).not.toHaveBeenCalled()
    expect(missionsApi.list).toHaveBeenCalledOnce()
  })

  it('removeMissionMember preserves the live Mission session renderer state', async () => {
    missionsApi.removeMember.mockResolvedValue({
      deleted: false,
      memberResults: [{ repoId: 'r1', worktreeId: null }]
    })
    missionsApi.list.mockResolvedValue([mission])
    const store = makeStore([missionWorkspace])

    await store.getState().removeMissionMember('m1', 'r1', true)

    expect(store.getState().purgeWorktreeTerminalState).not.toHaveBeenCalled()
    expect(missionsApi.list).toHaveBeenCalledOnce()
  })

  it('recreate clears the member error when refreshed durable state is clean', async () => {
    missionsApi.recreateMemberWorktree.mockResolvedValue({
      repoId: 'r2',
      worktreeId: 'r2::/wt',
      worktreeInstanceId: 'instance-r2'
    })
    missionsApi.list.mockResolvedValue([mission])
    const store = makeStore()
    store.setState({
      missionMemberErrors: { [missionMemberErrorKey('m1', 'r2')]: 'old' }
    })

    await store.getState().recreateMissionMemberWorktree('m1', 'r2')

    expect(store.getState().missionMemberErrors[missionMemberErrorKey('m1', 'r2')]).toBeUndefined()
  })
})
