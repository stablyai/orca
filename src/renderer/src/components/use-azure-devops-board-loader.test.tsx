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
import { useAzureDevOpsBoardLoader } from './use-azure-devops-board-loader'

const api = { loadBoard: vi.fn() }
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the loader reads window.api.azureDevOpsBoards.loadBoard only.
;(window as unknown as { api: unknown }).api = { azureDevOpsBoards: api }

const initialState = useAppStore.getInitialState()

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the loader reads only id, path and connectionId off the repo.
const repo = { id: 'repo-a', path: '/a', connectionId: null } as unknown as Repo
const teamRoute: AzureDevOpsTeamRoute = { teamName: 'Platform', teamId: 'team-1' }
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

function boardPage(level = requirement): AzureDevOpsBoardPage {
  return {
    level,
    configuration: {
      id: 'board-1',
      name: 'Stories',
      columns: [],
      rows: [],
      columnField: 'WEF_1_Kanban.Column',
      rowField: 'WEF_1_Kanban.Lane',
      doneField: 'WEF_1_Kanban.Column.Done',
      cardFields: {},
      tagColors: {},
      styleRules: []
    },
    items: [],
    parents: []
  }
}

function render(args: { view?: 'backlog' | 'board'; level?: AzureDevOpsBacklogLevel } = {}) {
  return renderHook(
    (props: { view: 'backlog' | 'board'; level: AzureDevOpsBacklogLevel }) =>
      useAzureDevOpsBoardLoader({
        active: true,
        repo,
        teamRoute,
        level: props.level,
        view: props.view
      }),
    { initialProps: { view: args.view ?? 'board', level: args.level ?? requirement } }
  )
}

describe('useAzureDevOpsBoardLoader', () => {
  beforeEach(() => {
    useAppStore.setState(initialState, true)
    api.loadBoard.mockReset()
    api.loadBoard.mockResolvedValue(boardPage())
  })
  afterEach(() => {
    cleanup()
    useAppStore.setState(initialState, true)
  })

  it('loads the board only once the Board view is selected', async () => {
    const { result, rerender } = render({ view: 'backlog' })
    await act(async () => {
      await Promise.resolve()
    })
    expect(api.loadBoard).not.toHaveBeenCalled()
    expect(result.current.status).toBe('idle')

    rerender({ view: 'board', level: requirement })
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(api.loadBoard).toHaveBeenCalledWith(
      expect.objectContaining({ repoId: 'repo-a', teamId: 'team-1', level: requirement })
    )
    expect(result.current.board?.configuration.id).toBe('board-1')
  })

  it('reuses the cached board when switching back from Backlog', async () => {
    const { result, rerender } = render()
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(api.loadBoard).toHaveBeenCalledTimes(1)

    rerender({ view: 'backlog', level: requirement })
    rerender({ view: 'board', level: requirement })
    await waitFor(() => expect(result.current.board).not.toBeNull())
    expect(api.loadBoard).toHaveBeenCalledTimes(1)
  })

  it('forces a reload on refresh', async () => {
    const { result } = render()
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(api.loadBoard).toHaveBeenCalledTimes(1)

    act(() => result.current.refresh())
    await waitFor(() => expect(api.loadBoard).toHaveBeenCalledTimes(2))
    expect(result.current.status).toBe('ready')
  })

  it('reports an error message when the load rejects', async () => {
    api.loadBoard.mockRejectedValue(
      new Error('Azure DevOps returned 200 of 250 board work items for Backlog items')
    )
    const { result } = render()
    await waitFor(() => expect(result.current.status).toBe('error'))
    expect(result.current.errorMessage).toContain('200 of 250')
    expect(result.current.board).toBeNull()
  })

  it('clears collapsed lanes when the level changes', async () => {
    const { result, rerender } = render()
    await waitFor(() => expect(result.current.status).toBe('ready'))
    act(() => result.current.toggleLane('r1'))
    expect(result.current.collapsedLaneIds.has('r1')).toBe(true)

    rerender({ view: 'board', level: features })
    expect(result.current.collapsedLaneIds.size).toBe(0)
    await waitFor(() => expect(result.current.status).toBe('ready'))
  })
})
