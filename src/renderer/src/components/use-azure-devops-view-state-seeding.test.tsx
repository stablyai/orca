// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  AzureDevOpsBacklogPage,
  AzureDevOpsBacklogViewSettings
} from '../../../shared/azure-devops/boards-types'
import type { Repo } from '../../../shared/repo-types'
import { EMPTY_BACKLOG_FILTERS } from './task-page-azure-devops-backlog-filters'
import { useAzureDevOpsViewStateSeeding } from './use-azure-devops-view-state-seeding'

afterEach(() => cleanup())

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the seeding hook reads only the repo id.
const repo = { id: 'repo-a' } as Repo
const viewSettings: AzureDevOpsBacklogViewSettings = {
  columnOptionsByLevel: {},
  showParents: true,
  inProgressFilter: false,
  savedFiltersByLevel: {
    req: {
      keyword: 'login',
      workItemTypes: ['Bug'],
      assignedTo: [],
      states: [],
      areaPaths: [],
      iterationPaths: [],
      tags: []
    }
  }
}

function page(levelId: string): AzureDevOpsBacklogPage {
  return {
    level: {
      id: levelId,
      name: levelId,
      rank: 1,
      kind: 'requirement',
      workItemTypes: [],
      columnFields: [],
      hidden: false
    },
    items: [],
    childrenByParent: {},
    children: [],
    parents: []
  }
}

type Props = {
  teamName: string | null
  levelId: string | null
  viewSettings: AzureDevOpsBacklogViewSettings | null
  configurationLoaded: boolean
  page: AzureDevOpsBacklogPage | null
}

function render(initial: Props) {
  const setShowParents = vi.fn()
  const setShowInProgress = vi.fn()
  const setFilters = vi.fn()
  const hook = renderHook(
    (props: Props) =>
      useAzureDevOpsViewStateSeeding({
        repo,
        ...props,
        setShowParents,
        setShowInProgress,
        setFilters
      }),
    { initialProps: initial }
  )
  return { ...hook, setShowParents, setShowInProgress, setFilters }
}

describe('useAzureDevOpsViewStateSeeding', () => {
  it('seeds Show parents and In progress items once per team when the configuration lands', () => {
    const { rerender, setShowParents, setShowInProgress } = render({
      teamName: 'Mobile',
      levelId: null,
      viewSettings: null,
      configurationLoaded: false,
      page: null
    })
    expect(setShowParents).not.toHaveBeenCalled()

    rerender({
      teamName: 'Mobile',
      levelId: null,
      viewSettings,
      configurationLoaded: true,
      page: null
    })
    expect(setShowParents).toHaveBeenCalledWith(true)
    expect(setShowInProgress).toHaveBeenCalledWith(false)

    // Why: a refetched configuration object must not undo a local toggle.
    rerender({
      teamName: 'Mobile',
      levelId: null,
      viewSettings: { ...viewSettings },
      configurationLoaded: true,
      page: null
    })
    expect(setShowParents).toHaveBeenCalledTimes(1)

    rerender({
      teamName: 'Platform',
      levelId: null,
      viewSettings: { ...viewSettings, showParents: null, inProgressFilter: null },
      configurationLoaded: true,
      page: null
    })
    expect(setShowParents).toHaveBeenLastCalledWith(false)
    expect(setShowInProgress).toHaveBeenLastCalledWith(true)
  })

  it('seeds the saved filter once per level after its page loads, and empties levels without one', () => {
    const base = { teamName: 'Mobile', viewSettings, configurationLoaded: true }
    const { rerender, setFilters } = render({ ...base, levelId: 'req', page: null })
    expect(setFilters).not.toHaveBeenCalled()

    // Why: a stale page from the previous level must not seed the new one.
    rerender({ ...base, levelId: 'req', page: page('feat') })
    expect(setFilters).not.toHaveBeenCalled()

    rerender({ ...base, levelId: 'req', page: page('req') })
    expect(setFilters).toHaveBeenCalledTimes(1)
    const seeded = setFilters.mock.calls[0][0]
    expect(seeded.keyword).toBe('login')
    expect([...seeded.workItemTypes]).toEqual(['Bug'])

    rerender({ ...base, levelId: 'req', page: page('req') })
    expect(setFilters).toHaveBeenCalledTimes(1)

    rerender({ ...base, levelId: 'feat', page: page('feat') })
    expect(setFilters).toHaveBeenCalledTimes(2)
    expect(setFilters).toHaveBeenLastCalledWith(EMPTY_BACKLOG_FILTERS)
  })
})
