// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { useAppStore } from '@/store'
import type {
  AzureDevOpsBacklogLevel,
  AzureDevOpsTeamConfiguration
} from '../../../shared/azure-devops/boards-types'
import type { Repo } from '../../../shared/repo-types'
import { useAzureDevOpsBacklogLoader } from './use-azure-devops-backlog-loader'

const toastError = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast: { error: toastError } }))

const api = {
  isAuthenticated: vi.fn(),
  listTeams: vi.fn(),
  getConfiguration: vi.fn(),
  loadBacklog: vi.fn(),
  getWorkItem: vi.fn()
}
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the loader reads window.api.azureDevOpsBoards only.
;(window as unknown as { api: unknown }).api = { azureDevOpsBoards: api }

const initialState = useAppStore.getInitialState()

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the loader reads only id, path and connectionId off the repo.
const repoA = { id: 'repo-a', path: '/a', connectionId: null } as unknown as Repo
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the loader reads only id, path and connectionId off the repo.
const repoB = { id: 'repo-b', path: '/b', connectionId: null } as unknown as Repo
// Why: the same repo re-created, as updateRepo does on changes the loader does not care about.
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the loader reads only id, path and connectionId off the repo.
const repoAReplaced = { id: 'repo-a', path: '/a', connectionId: null } as unknown as Repo
const teams = [
  { id: 'team-1', name: 'Platform', isDefault: true },
  { id: 'team-2', name: 'Mobile', isDefault: false }
]
const requirement: AzureDevOpsBacklogLevel = {
  id: 'Microsoft.RequirementCategory',
  name: 'Backlog items',
  rank: 2,
  kind: 'requirement',
  workItemTypes: ['Product Backlog Item'],
  columnFields: [],
  hidden: false
}
const taskLevel: AzureDevOpsBacklogLevel = {
  ...requirement,
  id: 'Microsoft.TaskCategory',
  name: 'Tasks',
  kind: 'task',
  rank: 1
}

function configuration(
  levels: AzureDevOpsBacklogLevel[],
  repo = { organization: 'acme', project: 'Project' }
): AzureDevOpsTeamConfiguration {
  return {
    backlog: levels.length > 0 ? { levels, bugsBehavior: 'asRequirements' } : null,
    iterations: [],
    workItemTypes: {},
    repo
  }
}

function page(levelId = requirement.id) {
  return {
    level: { ...requirement, id: levelId },
    items: [],
    childrenByParent: {},
    children: [],
    parents: []
  }
}

function render(
  args: {
    repo?: Repo | null
    settings?: {
      azureDevOpsTeamSelection: Record<string, string> | null
      azureDevOpsViewSelection: Record<string, string> | null
    } | null
    updateSettings?: (patch: unknown) => Promise<unknown>
  } = {}
) {
  const updateSettings = args.updateSettings ?? vi.fn(async () => undefined)
  return renderHook(
    (props: { repo: Repo | null }) =>
      useAzureDevOpsBacklogLoader({
        active: props.repo !== null,
        repo: props.repo,
        settings: args.settings ?? {
          azureDevOpsTeamSelection: null,
          azureDevOpsViewSelection: null
        },
        updateSettings
      }),
    { initialProps: { repo: args.repo === undefined ? repoA : args.repo } }
  )
}

describe('useAzureDevOpsBacklogLoader', () => {
  beforeEach(() => {
    useAppStore.setState(initialState, true)
    for (const fn of Object.values(api)) {
      fn.mockReset()
    }
    toastError.mockReset()
    api.isAuthenticated.mockResolvedValue(true)
    api.listTeams.mockResolvedValue(teams)
    api.getConfiguration.mockResolvedValue(configuration([requirement, taskLevel]))
    api.loadBacklog.mockResolvedValue(page())
  })
  afterEach(() => {
    cleanup()
    useAppStore.setState(initialState, true)
  })

  it('reports a non Azure DevOps repo before probing auth or teams', async () => {
    api.isAuthenticated.mockRejectedValue(new Error('azure_devops_remote_required'))
    const { result } = render()
    await waitFor(() => expect(result.current.status).toBe('not-azure-remote'))
    expect(api.listTeams).not.toHaveBeenCalled()
  })

  it('reports an unreachable host as host-unreachable, never as a missing remote', async () => {
    api.isAuthenticated.mockRejectedValue(new Error('azure_devops_repo_unverifiable'))
    const { result } = render()
    await waitFor(() => expect(result.current.status).toBe('host-unreachable'))
  })

  it('shows unauthenticated once the repo is known to be Azure DevOps', async () => {
    api.isAuthenticated.mockResolvedValue(false)
    const { result } = render()
    await waitFor(() => expect(result.current.status).toBe('unauthenticated'))
    expect(api.listTeams).not.toHaveBeenCalled()
  })

  it('surfaces a failed team list as an error with the HTTP status', async () => {
    api.listTeams.mockRejectedValue(new Error('Azure DevOps request failed: HTTP 401'))
    const { result } = render()
    await waitFor(() => expect(result.current.status).toBe('error'))
    expect(result.current.errorMessage).toContain('HTTP 401')
  })

  it('loads default team → configuration → backlog and routes by team id', async () => {
    const { result } = render()
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.teamName).toBe('Platform')
    expect(result.current.team?.id).toBe('team-1')
    expect(result.current.level?.id).toBe(requirement.id)
    expect(api.getConfiguration).toHaveBeenCalledWith(
      expect.objectContaining({ repoId: 'repo-a', teamName: 'Platform', teamId: 'team-1' })
    )
    expect(api.loadBacklog).toHaveBeenCalledWith(
      expect.objectContaining({ teamId: 'team-1', level: requirement })
    )
  })

  it('hydrates the user column options for the level, falling back to process columns', async () => {
    const userColumns = [
      { referenceName: 'System.Title', name: 'Title', width: 320 },
      { referenceName: 'System.Parent', name: 'Parent', width: 200 }
    ]
    api.getConfiguration.mockResolvedValue({
      ...configuration([requirement, taskLevel]),
      viewSettings: {
        columnOptionsByLevel: { [requirement.id]: userColumns },
        showParents: null,
        inProgressFilter: null,
        savedFiltersByLevel: {}
      }
    })
    const { result } = render()
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.columns).toEqual(userColumns)
    expect(api.loadBacklog).toHaveBeenCalledWith(
      expect.objectContaining({ columnFields: ['System.Title', 'System.Parent'] })
    )
  })

  it('applies the persisted team once per repo and never reverts a later user pick', async () => {
    const updateSettings = vi.fn(async () => undefined)
    const { result } = render({
      settings: {
        azureDevOpsTeamSelection: { 'acme/Project': 'Mobile' },
        azureDevOpsViewSelection: null
      },
      updateSettings
    })
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.teamName).toBe('Mobile')
    expect(api.getConfiguration).toHaveBeenCalledTimes(2)

    act(() => result.current.selectTeam('Platform'))
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.teamName).toBe('Platform')
    expect(updateSettings).toHaveBeenCalledWith({
      azureDevOpsTeamSelection: { 'acme/Project': 'Platform' }
    })
    // Why: settings still say Mobile until the write lands; the loader must not flip back.
    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current.teamName).toBe('Platform')
    expect(api.loadBacklog).toHaveBeenLastCalledWith(
      expect.objectContaining({ teamName: 'Platform' })
    )
  })

  it('toasts when persisting the team selection fails', async () => {
    const { result } = render({
      updateSettings: vi.fn(async () => {
        throw new Error('strict schema')
      })
    })
    await waitFor(() => expect(result.current.status).toBe('ready'))
    act(() => result.current.selectTeam('Mobile'))
    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1))
    expect(toastError.mock.calls[0][0]).toContain('strict schema')
    expect(result.current.teamName).toBe('Mobile')
  })

  it('reports an error instead of spinning when the team has no visible level', async () => {
    api.getConfiguration.mockResolvedValue(configuration([]))
    const { result } = render()
    await waitFor(() => expect(result.current.status).toBe('error'))
    expect(result.current.errorMessage).toMatch(/backlog levels/)
    expect(api.loadBacklog).not.toHaveBeenCalled()
  })

  it('never offers the task backlog as a level', async () => {
    api.getConfiguration.mockResolvedValue(configuration([taskLevel]))
    const { result } = render()
    await waitFor(() => expect(result.current.status).toBe('error'))
    expect(result.current.levelId).toBeNull()
  })

  it('resets team, configuration, level and page when the repo changes', async () => {
    const { result, rerender } = render()
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.page).not.toBeNull()

    api.listTeams.mockResolvedValue([{ id: 'team-9', name: 'Web', isDefault: true }])
    api.getConfiguration.mockResolvedValue(
      configuration([requirement], { organization: 'other', project: 'Other' })
    )
    rerender({ repo: repoB })
    expect(result.current.teamName).toBeNull()
    expect(result.current.configuration).toBeNull()
    expect(result.current.page).toBeNull()
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.teamName).toBe('Web')
    expect(api.getConfiguration).toHaveBeenLastCalledWith(
      expect.objectContaining({ repoId: 'repo-b', teamName: 'Web' })
    )
  })

  it('keeps the team when the repo object is replaced but its identity has not changed', async () => {
    const { result, rerender } = render()
    await waitFor(() => expect(result.current.status).toBe('ready'))
    const teamName = result.current.teamName
    const listed = api.listTeams.mock.calls.length

    rerender({ repo: repoAReplaced })

    expect(result.current.teamName).toBe(teamName)
    expect(result.current.status).toBe('ready')
    expect(api.listTeams).toHaveBeenCalledTimes(listed)
  })

  it('serves a cached page and revalidates only on refresh', async () => {
    const { result } = render()
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(api.loadBacklog).toHaveBeenCalledTimes(1)

    act(() => result.current.refresh())
    await waitFor(() => expect(api.loadBacklog).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(result.current.refreshing).toBe(false))

    // Why: force is one-shot; a level re-select after a refresh goes back to the fresh cache.
    act(() => result.current.setLevelId(null))
    act(() => result.current.setLevelId(requirement.id))
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(api.loadBacklog).toHaveBeenCalledTimes(2)
  })

  it('never loads the backlog when the Board view is the restored choice', async () => {
    const { result } = render({
      settings: {
        azureDevOpsTeamSelection: null,
        azureDevOpsViewSelection: {
          'acme/Project::Platform::Microsoft.RequirementCategory': 'board'
        }
      }
    })
    await waitFor(() => expect(result.current.view).toBe('board'))
    await act(async () => {
      await Promise.resolve()
    })
    expect(api.loadBacklog).not.toHaveBeenCalled()
    expect(result.current.status).toBe('ready')
  })

  it('does not request the backlog while the Board view is active', async () => {
    const { result } = render()
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(api.loadBacklog).toHaveBeenCalledTimes(1)

    act(() => result.current.selectView('board'))
    await waitFor(() => expect(result.current.view).toBe('board'))
    act(() => result.current.refresh())
    await act(async () => {
      await Promise.resolve()
    })
    expect(api.loadBacklog).toHaveBeenCalledTimes(1)
    expect(result.current.status).toBe('ready')
  })

  it('drops a backlog failure when the Board takes over, and reloads on the way back', async () => {
    api.loadBacklog.mockRejectedValue(new Error('Azure DevOps request failed: HTTP 403'))
    const { result } = render()
    await waitFor(() => expect(result.current.status).toBe('error'))
    expect(result.current.errorMessage).toContain('HTTP 403')

    // Why: the page-level status is what Content shows; under Board it must not be the backlog's.
    act(() => result.current.selectView('board'))
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.errorMessage).toBeNull()

    api.loadBacklog.mockResolvedValue(page())
    act(() => result.current.selectView('backlog'))
    await waitFor(() => expect(api.loadBacklog).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.page).not.toBeNull()
  })

  it('reuses a fresh cached backlog when switching back from the Board', async () => {
    const { result } = render()
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(api.loadBacklog).toHaveBeenCalledTimes(1)

    act(() => result.current.selectView('board'))
    await waitFor(() => expect(result.current.view).toBe('board'))
    act(() => result.current.selectView('backlog'))
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(api.loadBacklog).toHaveBeenCalledTimes(1)
    expect(result.current.page).not.toBeNull()
  })

  it('ignores results that land after unmount', async () => {
    let resolveTeams: (value: typeof teams) => void = () => undefined
    api.listTeams.mockImplementation(
      () =>
        new Promise<typeof teams>((resolve) => {
          resolveTeams = resolve
        })
    )
    const { result, unmount } = render()
    await waitFor(() => expect(api.listTeams).toHaveBeenCalled())
    unmount()
    await act(async () => {
      resolveTeams(teams)
    })
    expect(api.getConfiguration).not.toHaveBeenCalled()
    expect(result.current.teamName).toBeNull()
  })
})
