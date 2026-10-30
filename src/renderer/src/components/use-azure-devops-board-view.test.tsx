// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { useAppStore } from '@/store'
import type {
  AzureDevOpsBacklogLevel,
  AzureDevOpsBoardPage
} from '../../../shared/azure-devops/boards-types'
import type { AzureDevOpsTeamRoute } from '../../../shared/azure-devops/boards-repo-resolution'
import type { Repo } from '../../../shared/repo-types'
import {
  useAzureDevOpsBoardView,
  useAzureDevOpsBoardViewSelection
} from './use-azure-devops-board-view'
import {
  azureDevOpsViewSelectionKey,
  readAzureDevOpsViewSelection
} from './task-page-azure-devops-team-selection-persistence'

const toastInfo = vi.hoisted(() => vi.fn())
const toastError = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast: { info: toastInfo, error: toastError } }))

const api = { loadBoard: vi.fn() }
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the loader reads window.api.azureDevOpsBoards.loadBoard only.
;(window as unknown as { api: unknown }).api = { azureDevOpsBoards: api }

const initialState = useAppStore.getInitialState()

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the loader reads only id, path and connectionId off the repo.
const repo = { id: 'repo-a', path: '/a', connectionId: null } as unknown as Repo
const teamRoute: AzureDevOpsTeamRoute = { teamName: 'Platform', teamId: 'team-1' }
const adoRepo = { organization: 'acme', project: 'Project' }
const requirement: AzureDevOpsBacklogLevel = {
  id: 'Microsoft.RequirementCategory',
  name: 'Backlog items',
  rank: 2,
  kind: 'requirement',
  workItemTypes: ['Product Backlog Item'],
  columnFields: [],
  hidden: false
}
const features: AzureDevOpsBacklogLevel = {
  ...requirement,
  id: 'Microsoft.FeatureCategory',
  name: 'Features',
  kind: 'portfolio',
  rank: 3
}
const requirementKey = azureDevOpsViewSelectionKey(adoRepo, 'Platform', requirement.id)
const featuresKey = azureDevOpsViewSelectionKey(adoRepo, 'Platform', features.id)

function boardPage(level = requirement): AzureDevOpsBoardPage {
  return {
    level,
    configuration: {
      id: 'board-1',
      name: 'Stories',
      columns: [],
      rows: [],
      columnField: 'Kanban.Column',
      rowField: 'Kanban.Lane',
      doneField: 'Kanban.Column.Done',
      cardFields: {},
      tagColors: {},
      styleRules: []
    },
    items: [],
    parents: []
  }
}

beforeEach(() => {
  useAppStore.setState(initialState, true)
  api.loadBoard.mockReset()
  api.loadBoard.mockResolvedValue(boardPage())
  toastInfo.mockReset()
  toastError.mockReset()
})
afterEach(() => {
  cleanup()
  useAppStore.setState(initialState, true)
})

describe('useAzureDevOpsBoardViewSelection', () => {
  function render(args: {
    viewKey?: string | null
    stored?: Record<string, string> | null
    updateSettings?: (patch: unknown) => Promise<unknown>
  }) {
    const updateSettings = args.updateSettings ?? vi.fn(async () => undefined)
    const hook = renderHook(
      (props: { viewKey: string | null; stored: Record<string, string> | null }) =>
        useAzureDevOpsBoardViewSelection({
          viewKey: props.viewKey,
          settings: { azureDevOpsViewSelection: props.stored },
          updateSettings
        }),
      {
        initialProps: {
          viewKey: args.viewKey === undefined ? requirementKey : args.viewKey,
          stored: args.stored ?? null
        }
      }
    )
    return { ...hook, updateSettings }
  }

  it('restores a persisted board selection for the current project, team and level', () => {
    const { result } = render({ stored: { [requirementKey]: 'board' } })
    expect(result.current.view).toBe('board')
    expect(result.current.boardAvailable).toBe(true)
  })

  it('lands on Work items when another level is the only persisted choice', () => {
    const { result } = render({ stored: { [featuresKey]: 'board' } })
    expect(result.current.view).toBe('workItems')
  })

  it('lands on Work items with nothing persisted, and restores a persisted backlog choice', () => {
    expect(render({}).result.current.view).toBe('workItems')
    expect(render({ stored: { [requirementKey]: 'backlog' } }).result.current.view).toBe('backlog')
  })

  it('persists a change under the level key', () => {
    const { result, updateSettings } = render({ stored: { [featuresKey]: 'board' } })
    act(() => result.current.selectView('board'))
    expect(result.current.view).toBe('board')
    expect(updateSettings).toHaveBeenCalledWith({
      azureDevOpsViewSelection: { [featuresKey]: 'board', [requirementKey]: 'board' }
    })
  })

  it('does not persist before the project, team and level are known', () => {
    const { result, updateSettings } = render({ viewKey: null })
    expect(result.current.boardAvailable).toBe(false)
    act(() => result.current.selectView('board'))
    expect(updateSettings).not.toHaveBeenCalled()
  })

  it('ignores a persisted value that is not one of the three views', () => {
    const { result } = render({ stored: { [requirementKey]: 'kanban' } })
    expect(result.current.view).toBe('workItems')
    expect(
      readAzureDevOpsViewSelection({ azureDevOpsViewSelection: { k: 'kanban' } }, 'k')
    ).toBeNull()
    expect(readAzureDevOpsViewSelection({ azureDevOpsViewSelection: { k: 'board' } }, 'k')).toBe(
      'board'
    )
    expect(
      readAzureDevOpsViewSelection({ azureDevOpsViewSelection: { k: 'workItems' } }, 'k')
    ).toBe('workItems')
    expect(
      readAzureDevOpsViewSelection({ azureDevOpsViewSelection: { k: 'board' } }, null)
    ).toBeNull()
  })

  it('keeps the picked view when a later settings push still says backlog', () => {
    const { result, rerender } = render({ stored: null })
    act(() => result.current.selectView('board'))
    expect(result.current.view).toBe('board')
    // Why: the write lands asynchronously; a settings push must not revert the pick.
    rerender({ viewKey: requirementKey, stored: null })
    expect(result.current.view).toBe('board')
    rerender({ viewKey: requirementKey, stored: { [requirementKey]: 'board' } })
    expect(result.current.view).toBe('board')
  })

  it('keeps the current view when the level has no stored choice of its own', () => {
    const { result, rerender } = render({ stored: { [requirementKey]: 'backlog' } })
    expect(result.current.view).toBe('backlog')
    rerender({ viewKey: featuresKey, stored: { [requirementKey]: 'backlog' } })
    expect(result.current.view).toBe('backlog')
    // A stored choice for the new level still wins over what is on screen.
    rerender({
      viewKey: featuresKey,
      stored: { [requirementKey]: 'backlog', [featuresKey]: 'board' }
    })
    expect(result.current.view).toBe('board')
  })

  it('remembers a board-less level for the session, per level', () => {
    const { result, rerender } = render({ stored: { [requirementKey]: 'board' } })
    expect(result.current.view).toBe('board')

    act(() => result.current.reportNoBoard())
    expect(result.current.view).toBe('backlog')
    expect(result.current.boardAvailable).toBe(false)
    expect(toastInfo).toHaveBeenCalledTimes(1)
    // Why: the memory must survive a re-pick, or the persisted 'board' would restore it.
    act(() => result.current.selectView('board'))
    expect(result.current.boardAvailable).toBe(false)

    rerender({ viewKey: featuresKey, stored: { [requirementKey]: 'board' } })
    expect(result.current.boardAvailable).toBe(true)
    rerender({ viewKey: requirementKey, stored: { [requirementKey]: 'board' } })
    expect(result.current.boardAvailable).toBe(false)
    expect(result.current.view).toBe('backlog')
  })
})

describe('useAzureDevOpsBoardView', () => {
  function render(args: { view?: 'backlog' | 'board'; reportNoBoard?: () => void } = {}) {
    const reportNoBoard = args.reportNoBoard ?? vi.fn()
    const hook = renderHook(
      (props: { level: AzureDevOpsBacklogLevel; view: 'backlog' | 'board' }) =>
        useAzureDevOpsBoardView({
          active: true,
          repo,
          teamRoute,
          level: props.level,
          view: props.view,
          reportNoBoard
        }),
      { initialProps: { level: requirement, view: args.view ?? 'board' } }
    )
    return { ...hook, reportNoBoard }
  }

  it('loads the board while the Board view is selected', async () => {
    const { result } = render()
    await waitFor(() => expect(result.current.boardStatus).toBe('ready'))
    expect(result.current.board?.configuration.id).toBe('board-1')
    expect(result.current.boardErrorStatus).toBeNull()
  })

  it('reports a level with no board once', async () => {
    api.loadBoard.mockResolvedValue(null)
    const { result, rerender, reportNoBoard } = render()
    await waitFor(() => expect(reportNoBoard).toHaveBeenCalledTimes(1))
    expect(result.current.board).toBeNull()
    expect(result.current.boardErrorMessage).toBeNull()

    // Why: the notice must not fire again on every later render of the same selection.
    rerender({ level: requirement, view: 'board' })
    rerender({ level: requirement, view: 'board' })
    await act(async () => {
      await Promise.resolve()
    })
    expect(reportNoBoard).toHaveBeenCalledTimes(1)
    expect(api.loadBoard).toHaveBeenCalledTimes(1)
  })

  it('carries an unreachable host through as its own status, not a raw message', async () => {
    api.loadBoard.mockRejectedValue(new Error('azure_devops_repo_unverifiable'))
    const { result } = render()
    await waitFor(() => expect(result.current.boardStatus).toBe('error'))
    expect(result.current.boardErrorStatus).toBe('host-unreachable')
  })

  it('keeps a plain failure as an error with its message', async () => {
    api.loadBoard.mockRejectedValue(new Error('Azure DevOps request failed: HTTP 500'))
    const { result } = render()
    await waitFor(() => expect(result.current.boardStatus).toBe('error'))
    expect(result.current.boardErrorStatus).toBe('error')
    expect(result.current.boardErrorMessage).toContain('HTTP 500')
  })
})
