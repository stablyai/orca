import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ActionsRunDetailsPanel } from './ActionsRunDetailsPanel'
import { createEditorTabsStore } from '@/store/slices/editor-slice-test-harness'
import type { PRCheckRunDetails } from '../../../../shared/github/check-types'
import { actionsDurationSeconds } from '../../../../shared/github/actions-duration'

function markup(details: PRCheckRunDetails) {
  const store = createEditorTabsStore()
  store.getState().openCheckRunDetails(
    'folder:parent',
    'actions',
    { name: 'Workflow', status: 'completed', conclusion: 'failure', workflowRunId: 9, url: null },
    {
      details,
      loading: false,
      error: null,
      actionsContext: { repoId: 'repo-1', repoPath: '/repo' }
    }
  )
  return renderToStaticMarkup(
    <TooltipProvider>
      <ActionsRunDetailsPanel file={store.getState().openFiles[0]} />
    </TooltipProvider>
  )
}
const details: PRCheckRunDetails = {
  name: 'Workflow',
  status: 'completed',
  conclusion: 'failure',
  url: null,
  detailsUrl: null,
  startedAt: null,
  completedAt: null,
  title: null,
  summary: null,
  text: null,
  annotations: [],
  jobs: [
    {
      id: 1,
      name: 'Failed job',
      status: 'completed',
      conclusion: 'failure',
      startedAt: null,
      completedAt: null,
      url: 'https://github.com/acme/repo/actions/runs/9/job/1',
      logTail: null,
      steps: []
    },
    {
      id: 2,
      name: 'Passing sibling',
      status: 'completed',
      conclusion: 'success',
      startedAt: null,
      completedAt: null,
      url: null,
      logTail: null,
      steps: []
    },
    {
      id: 3,
      name: 'Queued sibling',
      status: 'queued',
      conclusion: null,
      startedAt: null,
      completedAt: null,
      url: null,
      logTail: null,
      steps: []
    }
  ],
  actions: {
    repository: { owner: 'acme', repo: 'repo', host: 'github.com' },
    run: {
      id: 9,
      workflowId: 5,
      runAttempt: 1,
      runNumber: 7,
      name: 'Workflow',
      displayTitle: 'Run title',
      headBranch: 'main',
      headSha: null,
      event: 'push',
      actor: null,
      status: 'completed',
      conclusion: 'failure',
      htmlUrl: null,
      createdAt: null,
      updatedAt: null,
      runStartedAt: null
    },
    jobsPage: 1,
    totalJobs: 3,
    hasNextPage: false,
    limitReached: false,
    jobsError: null,
    logWarnings: []
  }
}
describe('whole-run presentation', () => {
  it('shows duration only for fully loaded completed runs, using job completion rather than updated time', () => {
    if (!details.actions) {
      throw new Error('Missing Actions fixture')
    }
    const complete = {
      ...details,
      jobs: details.jobs.map((job) => ({ ...job, completedAt: '2026-09-30T01:00:10Z' })),
      actions: {
        ...details.actions,
        run: {
          ...details.actions.run,
          runStartedAt: '2026-09-30T01:00:00Z',
          updatedAt: '2026-09-30T01:30:00Z'
        }
      }
    }
    expect(actionsDurationSeconds(complete)).toBe(10)
    for (const partial of [
      { hasNextPage: true },
      { limitReached: true },
      { jobsError: 'unavailable' },
      { totalJobs: null },
      { totalJobs: 4 }
    ]) {
      expect(
        actionsDurationSeconds({ ...complete, actions: { ...complete.actions, ...partial } })
      ).toBeNull()
    }
    expect(
      actionsDurationSeconds({
        ...complete,
        actions: { ...complete.actions, run: { ...complete.actions.run, status: 'in_progress' } }
      })
    ).toBeNull()
  })
  it('shows passing and queued siblings alongside failures without an AI mutation affordance', () => {
    const html = markup(details)
    expect(html).toContain('Passing sibling')
    expect(html).toContain('Queued sibling')
    expect(html).toContain('lucide-circle-dashed')
    expect(html).toContain('Open job on GitHub')
    expect(html).not.toContain('Fix with AI')
  })
  it('renders a jobs failure as a partial error with retry rather than no jobs', () => {
    const html = markup({
      ...details,
      jobs: [],
      actions: details.actions
        ? { ...details.actions, jobsError: 'Job page unavailable', logWarnings: ['expired'] }
        : undefined
    })
    expect(html).toContain('role="alert"')
    expect(html).toContain('Job page unavailable')
    expect(html).toContain('Retry')
    expect(html).toContain('Some log excerpts are unavailable')
    expect(html).not.toContain('No jobs are available')
  })
})
