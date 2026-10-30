// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import type { AzureDevOpsBacklogLevel } from '../../../../shared/azure-devops/boards-types'
import type { Repo } from '../../../../shared/repo-types'
import {
  AZURE_DEVOPS_BACKLOG_CACHE_TTL,
  azureDevOpsBacklogKey,
  azureDevOpsBoardKey,
  createAzureDevOpsBoardsSlice,
  type AzureDevOpsBoardsSlice
} from './azure-devops-boards'

const api = {
  isAuthenticated: vi.fn(),
  listTeams: vi.fn(),
  getConfiguration: vi.fn(),
  loadBacklog: vi.fn(),
  loadBoard: vi.fn(),
  getWorkItem: vi.fn()
}
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the slice reads window.api.azureDevOpsBoards only.
;(window as unknown as { api: unknown }).api = { azureDevOpsBoards: api }

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the slice reads only id, path and connectionId off the repo.
const repo = { id: 'repo-1', path: '/repo', connectionId: null } as unknown as Repo
const team = { teamName: 'Mobile', teamId: 'team-1' }
const level: AzureDevOpsBacklogLevel = {
  id: 'req',
  name: 'Backlog items',
  rank: 2,
  kind: 'requirement',
  workItemTypes: [],
  columnFields: [],
  hidden: false
}

function makeStore() {
  return create<AzureDevOpsBoardsSlice>()((...a) =>
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the test store composes this slice alone, so zustand's set/get carry exactly its state.
    createAzureDevOpsBoardsSlice(...(a as Parameters<typeof createAzureDevOpsBoardsSlice>))
  )
}

describe('azure-devops boards slice', () => {
  beforeEach(() => {
    for (const fn of Object.values(api)) {
      fn.mockReset()
    }
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('passes repo path, id and connection to listTeams and caches per repo', async () => {
    api.listTeams.mockResolvedValue([{ id: 't', name: 'Mobile', isDefault: true }])
    const store = makeStore()
    await store.getState().loadAzureDevOpsTeams(repo)
    expect(api.listTeams).toHaveBeenCalledWith({
      repoPath: '/repo',
      repoId: 'repo-1',
      connectionId: null
    })
    expect(store.getState().azureDevOpsTeamsByRepo['repo-1']).toEqual([
      { id: 't', name: 'Mobile', isDefault: true }
    ])
  })

  it('routes configuration and backlog requests with the team id', async () => {
    api.getConfiguration.mockResolvedValue({ backlog: null, iterations: [], workItemTypes: {} })
    api.loadBacklog.mockResolvedValue({ level, items: [] })
    const store = makeStore()
    await store.getState().loadAzureDevOpsConfiguration(repo, team)
    await store.getState().loadAzureDevOpsBacklog(repo, team, level)
    expect(api.getConfiguration).toHaveBeenCalledWith(
      expect.objectContaining({ teamName: 'Mobile', teamId: 'team-1' })
    )
    expect(api.loadBacklog).toHaveBeenCalledWith(
      expect.objectContaining({ teamName: 'Mobile', teamId: 'team-1', level })
    )
  })

  it('serves a fresh page from cache, revalidates a stale one, and always refetches with force', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    const page = { level, items: [], childrenByParent: {}, children: [], parents: [] }
    api.loadBacklog.mockResolvedValue(page)
    const store = makeStore()
    await store.getState().loadAzureDevOpsBacklog(repo, team, level)
    await store.getState().loadAzureDevOpsBacklog(repo, team, level)
    expect(api.loadBacklog).toHaveBeenCalledTimes(1)
    expect(
      store.getState().azureDevOpsBacklogByKey[azureDevOpsBacklogKey(repo, team, 'req')]?.page
    ).toBe(page)
    expect(store.getState().readAzureDevOpsBacklog(repo, team, level)).toEqual({
      page,
      fresh: true
    })

    vi.setSystemTime(1_000_000 + AZURE_DEVOPS_BACKLOG_CACHE_TTL + 1)
    expect(store.getState().readAzureDevOpsBacklog(repo, team, level)).toEqual({
      page,
      fresh: false
    })
    await store.getState().loadAzureDevOpsBacklog(repo, team, level)
    expect(api.loadBacklog).toHaveBeenCalledTimes(2)
    expect(store.getState().readAzureDevOpsBacklog(repo, team, level)?.fresh).toBe(true)

    await store.getState().loadAzureDevOpsBacklog(repo, team, level, { force: true })
    expect(api.loadBacklog).toHaveBeenCalledTimes(3)
  })

  it('reads null when nothing is cached for the key', () => {
    expect(makeStore().getState().readAzureDevOpsBacklog(repo, team, level)).toBeNull()
  })

  it('caches a loaded board per repo, team and level', async () => {
    const page = { level, configuration: {}, items: [], parents: [] }
    api.loadBoard.mockResolvedValue(page)
    const store = makeStore()
    await store.getState().loadAzureDevOpsBoard(repo, team, level)
    await expect(store.getState().loadAzureDevOpsBoard(repo, team, level)).resolves.toBe(page)
    expect(api.loadBoard).toHaveBeenCalledTimes(1)
    expect(api.loadBoard).toHaveBeenCalledWith({
      repoPath: '/repo',
      repoId: 'repo-1',
      connectionId: null,
      teamName: 'Mobile',
      teamId: 'team-1',
      level
    })
    expect(store.getState().readAzureDevOpsBoard(repo, team, level)).toBe(page)
  })

  it('reloads a board when force is set', async () => {
    api.loadBoard.mockResolvedValue({ level, configuration: {}, items: [], parents: [] })
    const store = makeStore()
    await store.getState().loadAzureDevOpsBoard(repo, team, level)
    await store.getState().loadAzureDevOpsBoard(repo, team, level, { force: true })
    expect(api.loadBoard).toHaveBeenCalledTimes(2)
  })

  it('reloads a board once its cache entry is stale', async () => {
    vi.useFakeTimers()
    api.loadBoard.mockResolvedValue({ level, configuration: {}, items: [], parents: [] })
    const store = makeStore()
    await store.getState().loadAzureDevOpsBoard(repo, team, level)
    vi.advanceTimersByTime(AZURE_DEVOPS_BACKLOG_CACHE_TTL + 1)
    await store.getState().loadAzureDevOpsBoard(repo, team, level)
    expect(api.loadBoard).toHaveBeenCalledTimes(2)
  })

  it('keeps a board for one level separate from another level’s board', async () => {
    const other = { ...level, id: 'epic' }
    api.loadBoard.mockImplementation(async (args: { level: { id: string } }) => ({
      level: args.level,
      configuration: {},
      items: [],
      parents: []
    }))
    const store = makeStore()
    await store.getState().loadAzureDevOpsBoard(repo, team, level)
    await store.getState().loadAzureDevOpsBoard(repo, team, other)
    expect(api.loadBoard).toHaveBeenCalledTimes(2)
    expect(azureDevOpsBoardKey(repo, team, 'req')).not.toBe(azureDevOpsBoardKey(repo, team, 'epic'))
    expect(azureDevOpsBoardKey(repo, team, 'req')).not.toBe(
      azureDevOpsBacklogKey(repo, team, 'req')
    )
    expect(store.getState().readAzureDevOpsBoard(repo, team, other)?.level.id).toBe('epic')
  })

  it('passes a level with no board through as null and does not cache it', async () => {
    api.loadBoard.mockResolvedValue(null)
    const store = makeStore()
    await expect(store.getState().loadAzureDevOpsBoard(repo, team, level)).resolves.toBeNull()
    expect(store.getState().readAzureDevOpsBoard(repo, team, level)).toBeNull()
  })

  it('returns null from readAzureDevOpsBoard before anything is loaded', () => {
    expect(makeStore().getState().readAzureDevOpsBoard(repo, team, level)).toBeNull()
  })
})
