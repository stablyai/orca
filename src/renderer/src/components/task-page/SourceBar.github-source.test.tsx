// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import { i18n } from '@/i18n/i18n'
import type { TaskSourceContext } from '../../../../shared/task-source-context'
import type { TaskPageComposerActionsModel } from './use-task-page-composer-actions'
import type { TaskPageRepoSourceState } from './task-page-cache-selectors'
import { getTaskSourceContextSummary } from '../task-source-context-summary'
import { TaskPageSourceBar } from './SourceBar'
import TaskPage from './TaskPage'

const upstream = { owner: 'upstream-owner', repo: 'project' }
const origin = { owner: 'fork-owner', repo: 'project' }
const context: TaskSourceContext = {
  provider: 'github',
  projectId: 'project',
  repoId: 'repo',
  hostId: 'local',
  providerIdentity: { provider: 'github', ...upstream }
}
const initialStore = useAppStore.getState()
const initialApiDescriptor = Object.getOwnPropertyDescriptor(window, 'api')
let sources: TaskPageRepoSourceState[]
let kind: 'issues' | 'prs'

vi.mock('./Surface', () => ({
  TaskPageSurface: ({ model }: { model: TaskPageComposerActionsModel }) => (
    <TooltipProvider>
      <TaskPageSourceBar
        model={{
          ...model,
          taskSource: 'github',
          githubMode: 'items',
          activeGithubTaskKind: kind,
          perRepoSourceState: sources,
          taskSourceRepoContexts: [context],
          taskSourceHostAvailability: [],
          taskSourceContextSummary: getTaskSourceContextSummary({
            provider: 'github',
            providerLabel: 'GitHub',
            repoContexts: [context]
          })
        }}
      />
    </TooltipProvider>
  )
}))

beforeEach(() => {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      gh: { viewer: vi.fn().mockResolvedValue({ login: 'octocat', email: null }) },
      ui: { set: vi.fn().mockResolvedValue(undefined) }
    }
  })
  useAppStore.setState(
    { ...initialStore, settings: null, persistedUIReady: false, repos: [], taskPageData: {} },
    true
  )
  kind = 'issues'
  sources = [
    {
      repoId: 'repo',
      repoPath: '/repo',
      hostId: 'local',
      sourceKey: 'repo::local',
      sources: {
        issues: upstream,
        prs: origin,
        originCandidate: origin,
        upstreamCandidate: upstream
      },
      error: null
    }
  ]
})
afterEach(async () => {
  await i18n.changeLanguage('en')
  cleanup()
  useAppStore.setState(initialStore, true)
  if (initialApiDescriptor) {
    Object.defineProperty(window, 'api', initialApiDescriptor)
  } else {
    Reflect.deleteProperty(window, 'api')
  }
})

function expectSource(owner: string) {
  const summary = screen.getByTitle(new RegExp(`Source: ${owner}/project`))
  expect(summary).toHaveTextContent(`${owner}/project`)
}

describe('Tasks GitHub source summary', () => {
  it('follows the resolved issue source when Origin is selected without changing project identity', () => {
    const view = render(<TaskPage />)
    expectSource('upstream-owner')
    sources = sources.map((state) => ({
      ...state,
      sources: { issues: origin, prs: origin, originCandidate: origin, upstreamCandidate: upstream }
    }))
    view.rerender(<TaskPage />)
    expectSource('fork-owner')
    expect(screen.queryByTitle(/Source: upstream-owner/)).not.toBeInTheDocument()
    expect(context.providerIdentity).toEqual({ provider: 'github', ...upstream })
  })

  it('keeps the active repository in translated summary output', async () => {
    await i18n.changeLanguage('es')
    kind = 'prs'
    render(<TaskPage />)
    expect(screen.getByTitle(/Fuente: fork-owner\/project/)).toHaveTextContent('fork-owner/project')
  })

  it('shows the PR source on the PR tab while issues still use upstream', () => {
    const view = render(<TaskPage />)
    expectSource('upstream-owner')
    kind = 'prs'
    view.rerender(<TaskPage />)
    expectSource('fork-owner')
  })

  it('does not claim the saved project identity while the list source is unresolved', () => {
    sources = sources.map((state) => ({ ...state, sources: null }))
    render(<TaskPage />)
    expect(screen.queryByTitle(/Source:/)).not.toBeInTheDocument()
    expect(screen.getByText(/GitHub · .*Selected project/)).toBeInTheDocument()
  })
})
