// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import type PRFilterDropdowns from '@/components/github/PRFilterDropdowns'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import TaskPage from '../TaskPage'
import type { TaskPageComposerActionsModel } from '../use-task-page-composer-actions'
import { TaskPageGitHubFilters } from './Filters'
import { createGlobalSettingsFixture } from '../../../../../shared/global-settings-test-fixture'
import type { Repo } from '../../../../../shared/repo-types'

let sourceFixture:
  | Pick<TaskPageComposerActionsModel, 'selectedRepos' | 'perRepoSourceState'>
  | undefined

vi.mock('../Surface', () => ({
  TaskPageSurface: ({ model }: { model: TaskPageComposerActionsModel }) => (
    <TooltipProvider>
      <button onClick={() => model.handleSelectGithubTaskKind('prs')}>PRs</button>
      <TaskPageGitHubFilters model={sourceFixture ? { ...model, ...sourceFixture } : model} />
    </TooltipProvider>
  )
}))
vi.mock('@/components/github/PRFilterDropdowns', () => ({
  default: ({ onChange }: ComponentProps<typeof PRFilterDropdowns>) => (
    <>
      <button onClick={() => onChange({ labels: ['bug'] })}>Bug label</button>
      <button onClick={() => onChange({ author: 'hubot' })}>Other author</button>
      <button onClick={() => onChange({ assignee: '@me' })}>Own assignee</button>
      <button onClick={() => onChange({ reviewer: { kind: 'requested', login: '@me' } })}>
        Own reviewer
      </button>
      <button onClick={() => onChange({ state: 'closed' })}>Closed</button>
      <button onClick={() => onChange({ state: 'open' })}>Reopen</button>
    </>
  )
}))

const initialStore = useAppStore.getState()
const initialApiDescriptor = Object.getOwnPropertyDescriptor(window, 'api')
const viewer = vi.fn<typeof window.api.gh.viewer>()

beforeEach(() => {
  sourceFixture = undefined
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
    click('Bug label')
    expectActive('Mine')
    click('Closed')
    expectActive('Mine', false)
    expectActive('Open', false)
    click('Reopen')
    expectActive('Mine')
    click('Other author')
    expectActive('Mine', false)
    expectActive('Open', false)
  })

  it('recognizes personal issue and review queries without clicking their presets', async () => {
    await renderFilters()
    click('Own assignee')
    expectActive('Assigned to me')
    click('PRs')
    click('Own reviewer')
    expectActive('Needs review')
    click('Closed')
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
    click('Bug label')
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
        {
          sourceContext: {
            kind: 'task-source',
            provider: 'github',
            projectId: 'repo:repo',
            projectHostSetupId: 'repo',
            hostId: 'local',
            repoId: 'repo',
            providerIdentity: null,
            accountLabel: null
          }
        }
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
      click('Bug label')
      expectActive('Mine')
      expect(useAppStore.getState().taskResumeState?.githubItemsPreset).toBeNull()
      expect(window.api.ui.set).toHaveBeenCalledWith({
        taskResumeState: expect.objectContaining({ githubItemsPreset: null })
      })
    }
  )
})

it.each([
  [100, 100],
  [1000, 100],
  [100, 1000],
  [1000, 1000]
])(
  'bounds actual Tasks source-chip lookup at R=%i F=%i and reuses unchanged selected rows',
  async (repoCount, sourceCount) => {
    let reads = 0
    const selectedRepos = Array.from({ length: repoCount }, (_, i): Repo => ({
      get id() {
        reads++
        return `repo-${i}`
      },
      executionHostId: 'runtime:server',
      path: `/repo-${i}`,
      displayName: `Selected ${i}`,
      badgeColor: 'gray',
      addedAt: 0
    }))
    const perRepoSourceState = Array.from({ length: sourceCount }, (_, i) => ({
      repoId: `repo-${repoCount - 1}`,
      hostId: 'runtime:server' as const,
      repoPath: `/repo-${repoCount - 1}`,
      sourceKey: `source-${i}`,
      sources: {
        issues: { owner: 'upstream', repo: `app-${i}` },
        prs: { owner: 'fork', repo: `app-${i}` },
        originCandidate: null,
        upstreamCandidate: null
      },
      error: null
    }))
    sourceFixture = { selectedRepos, perRepoSourceState }
    await renderFilters()
    expect(
      screen.getAllByTitle(new RegExp(`^Selected ${repoCount - 1}: Issues from upstream/`))
    ).toHaveLength(sourceCount)
    expect(reads).toBeLessThanOrEqual(3 * repoCount + 10)
    const coldReads = reads
    reads = 0
    await act(async () => useAppStore.setState({ activeRepoId: 'unrelated' }))
    expect(reads).toBe(0)
    await act(async () =>
      useAppStore.setState({ settings: createGlobalSettingsFixture({ terminalFontSize: 18 }) })
    )
    expect(reads).toBe(0)
    // Real model updates can render the header, but unchanged selected input must not rebuild its collection answer.
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'search' } })
    expect(reads).toBe(0)
    process.stdout.write(
      `PG6-F ${JSON.stringify({ repoCount, sourceCount, coldReads, warmReads: reads })}\n`
    )
  }
)

it('keeps source-chip exact host/first record, missing fallback and meaningful selected replacement', async () => {
  const first: Repo = {
    id: 'same',
    path: '/first',
    displayName: 'First server',
    executionHostId: 'runtime:server',
    badgeColor: 'gray',
    addedAt: 0
  }
  const rows: Repo[] = [
    { ...first, executionHostId: 'local', displayName: 'Wrong local' },
    first,
    { ...first, displayName: 'Later server' }
  ]
  sourceFixture = {
    selectedRepos: rows,
    perRepoSourceState: [
      {
        repoId: 'same',
        hostId: 'runtime:server',
        repoPath: '/first',
        sourceKey: 'source',
        sources: {
          issues: { owner: 'org', repo: 'upstream' },
          prs: { owner: 'fork', repo: 'origin' },
          originCandidate: null,
          upstreamCandidate: null
        },
        error: null
      }
    ]
  }
  await renderFilters()
  expect(screen.getByTitle('First server: Issues from org/upstream')).toBeTruthy()
  sourceFixture = { ...sourceFixture, selectedRepos: [rows[0], rows[2], first] }
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'reorder' } })
  expect(screen.getByTitle('Later server: Issues from org/upstream')).toBeTruthy()
  sourceFixture = { ...sourceFixture, selectedRepos: [rows[0]] }
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'missing' } })
  expect(screen.getByTitle('Issues from org/upstream')).toBeTruthy()
  expect(screen.queryByText('Wrong local')).toBeNull()
})
