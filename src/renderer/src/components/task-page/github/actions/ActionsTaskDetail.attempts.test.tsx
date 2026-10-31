// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import { TEST_REPO } from '@/store/slices/store-test-helpers'
import * as requests from '@/store/github/actions-requests'
import { ActionsTaskDetail } from './ActionsTaskDetail'
import type { ActionsRun, ActionsRunDetails } from '../../../../../../shared/github/actions-types'

vi.mock('./ActionsArtifacts', () => ({ ActionsArtifacts: () => null }))
const repository = { owner: 'acme', repo: 'widgets', host: 'github.com' }
const option = { repo: TEST_REPO, repository }
const run: ActionsRun = {
  id: 9,
  workflowId: 5,
  runNumber: 7,
  runAttempt: 3,
  name: 'Build',
  displayTitle: 'Build',
  headBranch: 'main',
  headSha: null,
  event: 'push',
  actor: null,
  status: 'completed',
  conclusion: 'success',
  htmlUrl: null,
  createdAt: null,
  updatedAt: null,
  runStartedAt: null
}
function result(attempt = 3, page = 1): ActionsRunDetails {
  return {
    name: 'Build',
    status: 'completed',
    conclusion: 'success',
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
        id: attempt * 100 + page,
        name: `Attempt ${attempt} job ${page}`,
        status: 'completed',
        conclusion: 'success',
        startedAt: null,
        completedAt: null,
        url: null,
        logTail: null,
        steps: []
      }
    ],
    actions: {
      repository,
      run: { ...run, runAttempt: attempt },
      latestAttempt: 3,
      jobsPage: page,
      hasNextPage: page === 1,
      limitReached: false,
      totalJobs: 101,
      jobsError: null,
      logWarnings: []
    }
  }
}
const originalRepos = useAppStore.getState().repos
beforeEach(() => {
  useAppStore.setState({ repos: [TEST_REPO] })
  vi.spyOn(requests, 'fetchActionsRunDetails').mockImplementation(async (_state, _context, args) =>
    result(args.attempt ?? 3, args.jobsPage ?? 1)
  )
})
afterEach(() => {
  cleanup()
  useAppStore.setState({ repos: originalRepos })
  vi.restoreAllMocks()
})
const mount = () =>
  render(
    <TooltipProvider>
      <ActionsTaskDetail option={option} run={run} onBack={vi.fn()} />
    </TooltipProvider>
  )
async function choose(attempt: number) {
  fireEvent.change(await screen.findByRole('spinbutton', { name: 'Attempt' }), {
    target: { value: String(attempt) }
  })
  fireEvent.click(screen.getByRole('button', { name: 'View attempt' }))
}

it('selects and refreshes an old attempt, appends its own jobs, and explicitly returns to latest', async () => {
  mount()
  await screen.findByText('Attempt 3 job 1')
  expect(screen.getByRole('button', { name: 'Latest attempt' }).getAttribute('aria-pressed')).toBe(
    'true'
  )
  await choose(1)
  await screen.findByText('Attempt 1 job 1')
  expect(screen.queryByText('Attempt 3 job 1')).toBeNull()
  expect(screen.getByRole('button', { name: 'Latest attempt' }).getAttribute('aria-pressed')).toBe(
    'false'
  )
  fireEvent.click(screen.getByRole('button', { name: 'Load more jobs' }))
  await screen.findByText('Attempt 1 job 2')
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
  await waitFor(() => expect(screen.queryByText('Attempt 1 job 2')).toBeNull())
  expect(vi.mocked(requests.fetchActionsRunDetails).mock.calls.at(-1)?.[2]).toMatchObject({
    attempt: 1,
    jobsPage: 1
  })
  fireEvent.click(screen.getByRole('button', { name: 'Latest attempt' }))
  await screen.findByText('Attempt 3 job 1')
})

it('ignores an older selection response and permission error after a newer selection succeeds', async () => {
  const held = Promise.withResolvers<ActionsRunDetails>()
  vi.mocked(requests.fetchActionsRunDetails).mockImplementation(async (_state, _context, args) =>
    args.attempt === 1 ? held.promise : result(args.attempt ?? 3)
  )
  mount()
  await screen.findByText('Attempt 3 job 1')
  await choose(1)
  await choose(2)
  await screen.findByText('Attempt 2 job 1')
  await act(async () => held.reject(new Error('Old forbidden response')))
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.queryByText('Attempt 1 job 1')).toBeNull()
  expect(screen.getByText('Attempt 2 job 1')).toBeTruthy()
})

it('does not label an ignored historical request as successful on an older host', async () => {
  vi.mocked(requests.fetchActionsRunDetails).mockResolvedValue(result(3))
  mount()
  await screen.findByText('Attempt 3 job 1')
  await choose(1)
  expect(await screen.findByRole('alert')).toHaveProperty(
    'textContent',
    expect.stringContaining('did not return the selected attempt')
  )
  expect(screen.queryByText('Attempt 3 job 1')).toBeNull()
})

it('keeps retry on the selected attempt after a permission failure and renders an empty attempt honestly', async () => {
  let denied = true
  vi.mocked(requests.fetchActionsRunDetails).mockImplementation(async (_state, _context, args) => {
    if (args.attempt === 1 && denied) {
      throw new Error('HTTP 403 permission required')
    }
    const next = result(args.attempt ?? 3)
    if (args.attempt === 1) {
      next.jobs = []
      next.actions.totalJobs = 0
      next.actions.hasNextPage = false
    }
    return next
  })
  mount()
  await screen.findByText('Attempt 3 job 1')
  await choose(1)
  expect(await screen.findByRole('alert')).toHaveProperty(
    'textContent',
    expect.stringContaining('HTTP 403')
  )
  denied = false
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  await screen.findByText('No jobs are available for this attempt.')
  expect(vi.mocked(requests.fetchActionsRunDetails).mock.calls.at(-1)?.[2].attempt).toBe(1)
  expect(screen.queryByText('Attempt 3 job 1')).toBeNull()
})

it('does not apply a pending selection after navigation to another run', async () => {
  const held = Promise.withResolvers<ActionsRunDetails>()
  vi.mocked(requests.fetchActionsRunDetails).mockImplementation(async (_state, _context, args) => {
    if (args.runId === 9 && args.attempt === 1) {
      return held.promise
    }
    const next = result(args.attempt ?? 3)
    if (args.runId === 10) {
      next.actions.run.id = 10
      next.jobs[0].name = 'Other run job'
    }
    return next
  })
  const view = mount()
  await screen.findByText('Attempt 3 job 1')
  await choose(1)
  view.rerender(
    <TooltipProvider>
      <ActionsTaskDetail
        option={option}
        run={{ ...run, id: 10, displayTitle: 'Other run' }}
        onBack={vi.fn()}
      />
    </TooltipProvider>
  )
  await screen.findByText('Other run job')
  await act(async () => held.resolve(result(1)))
  expect(screen.getByText('Other run job')).toBeTruthy()
  expect(screen.queryByText('Attempt 1 job 1')).toBeNull()
})
