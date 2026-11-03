// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import TaskPage from '../TaskPage'
import type { TaskPageComposerActionsModel } from '../use-task-page-composer-actions'
import { TaskPageGitHubFilters } from './Filters'
import { createGlobalSettingsFixture } from '../../../../../shared/global-settings-test-fixture'
import type { Repo } from '../../../../../shared/repo-types'

vi.mock('../Surface', () => ({
  TaskPageSurface: ({ model }: { model: TaskPageComposerActionsModel }) => (
    <TooltipProvider>
      <button onClick={() => model.handleSelectGithubTaskKind('prs')}>PRs</button>
      <TaskPageGitHubFilters model={model} />
    </TooltipProvider>
  )
}))

const initialStore = useAppStore.getState()
const initialApiDescriptor = Object.getOwnPropertyDescriptor(window, 'api')
const viewer = vi.fn<typeof window.api.gh.viewer>()

beforeEach(() => {
  viewer.mockReset().mockResolvedValue({ login: 'octocat', email: null })
  useAppStore.setState(
    { ...initialStore, settings: null, persistedUIReady: false, repos: [], taskPageData: {} },
    true
  )
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { gh: { viewer }, ui: { set: vi.fn().mockResolvedValue(undefined) } }
  })
})
afterEach(() => {
  cleanup()
  useAppStore.setState(initialStore, true)
  if (initialApiDescriptor) {
    Object.defineProperty(window, 'api', initialApiDescriptor)
  } else {
    Reflect.deleteProperty(window, 'api')
  }
})

function submitQuery(query: string) {
  const search = screen.getByRole('textbox')
  fireEvent.change(search, { target: { value: query } })
  fireEvent.keyDown(search, { key: 'Enter' })
}
function click(name: string) {
  fireEvent.click(screen.getByRole('button', { name }))
}
function expectActive(name: string, active = true) {
  const button = screen.getByRole('button', { name })
  if (active) {
    expect(button).toHaveClass('bg-foreground/90')
  } else {
    expect(button).not.toHaveClass('bg-foreground/90')
  }
}
async function renderFilters() {
  await act(async () => {
    render(<TaskPage />)
  })
}

describe('GitHub Tasks preset highlight follows the applied query', () => {
  it('keeps Mine after a label edit and restores it after reopening', async () => {
    await renderFilters()
    click('PRs')
    click('Mine')
    expectActive('Mine')
    submitQuery('is:pr is:open author:@me label:bug')
    expectActive('Mine')
    submitQuery('is:pr is:closed author:@me label:bug')
    expectActive('Mine', false)
    expectActive('Open', false)
    submitQuery('is:pr is:open author:@me label:bug')
    expectActive('Mine')
    submitQuery('is:pr is:open author:hubot label:bug')
    expectActive('Mine', false)
    expectActive('Open', false)
  })

  it('recognizes personal issue and review queries without clicking their presets', async () => {
    await renderFilters()
    submitQuery('is:issue is:open assignee:@me')
    expectActive('Assigned to me')
    click('PRs')
    submitQuery('is:pr is:open review-requested:@me')
    expectActive('Needs review')
    submitQuery('is:pr is:closed review-requested:@me')
    expectActive('Needs review', false)
  })

  it('derives Open from a submitted query and clears it for merged results', async () => {
    await renderFilters()
    click('PRs')
    const search = screen.getByPlaceholderText('Search GitHub PRs...')
    fireEvent.change(search, { target: { value: 'is:pr state:open' } })
    fireEvent.keyDown(search, { key: 'Enter' })
    expectActive('Open')
    fireEvent.change(search, { target: { value: 'is:pr is:merged author:@me' } })
    fireEvent.keyDown(search, { key: 'Enter' })
    expectActive('Open', false)
    expectActive('Mine', false)
  })

  it('does not equate absent state with the open presets', async () => {
    await renderFilters()
    for (const query of ['is:pr', 'is:pr author:@me', 'is:issue', 'is:issue assignee:@me']) {
      submitQuery(query)
      expectActive('Open', false)
      expectActive(query.includes('is:pr') ? 'Mine' : 'Assigned to me', false)
    }
  })

  it('matches @me tokens without treating literal logins as personal presets', async () => {
    await renderFilters()
    for (const [query, preset] of [
      ['is:pr is:open author:', 'Mine'],
      ['is:pr is:open review-requested:', 'Needs review'],
      ['is:issue is:open assignee:', 'Assigned to me']
    ]) {
      submitQuery(`${query}octocat`)
      expectActive(preset, false)
      expectActive('Open', false)
      submitQuery(`${query}@ME label:bug`)
      expectActive(preset)
    }
    expect(viewer).toHaveBeenCalledTimes(1)
  })

  it('keeps @me source-relative when the existing viewer lookup fails', async () => {
    viewer.mockRejectedValue(new Error('viewer unavailable'))
    await renderFilters()
    submitQuery('is:pr is:open author:@me label:bug')
    expectActive('Mine')
    submitQuery('is:pr is:open author:@me label:enhancement')
    expectActive('Mine')
    expect(viewer).toHaveBeenCalledTimes(1)
  })

  it.each([null, 'my-prs'] as const)(
    'restores hydrated saved query/preset without deriving back into saved state (%s)',
    async (preset) => {
      const savedQuery = 'is:pr is:open author:@me label:bug'
      const prefetchWorkItems = vi.fn()
      useAppStore.setState({
        repos: [
          {
            id: 'repo',
            path: '/repo',
            displayName: 'repo',
            badgeColor: 'gray',
            addedAt: 0
          } satisfies Repo
        ],
        prefetchWorkItems,
        settings: createGlobalSettingsFixture({ defaultTaskSource: 'github' }),
        taskResumeState: { githubItemsPreset: preset, githubItemsQuery: savedQuery }
      })
      const restoredQuery = preset === null ? savedQuery : 'author:@me is:pr is:open'
      useAppStore.getState().openTaskPage()
      expect(prefetchWorkItems).toHaveBeenCalledWith(
        'repo',
        '/repo',
        expect.any(Number),
        restoredQuery,
        { sourceContext: null }
      )
      useAppStore.setState({ repos: [] })
      await renderFilters()
      await act(async () => {
        useAppStore.setState({ persistedUIReady: true })
      })
      expect(screen.getByRole('textbox')).toHaveValue(restoredQuery)
      expectActive('Mine')
      expect(useAppStore.getState().taskResumeState?.githubItemsPreset).toBe(preset)
      expect(useAppStore.getState().taskResumeState?.githubItemsQuery).toBe(savedQuery)
      submitQuery('is:pr is:open author:@me label:enhancement')
      expectActive('Mine')
      expect(useAppStore.getState().taskResumeState?.githubItemsPreset).toBeNull()
      expect(window.api.ui.set).toHaveBeenCalledWith({
        taskResumeState: expect.objectContaining({ githubItemsPreset: null })
      })
    }
  )
})
