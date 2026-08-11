// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { PRCheckDetail, PRCheckRunDetails } from '../../../../shared/types'
import { ChecksList } from './checks-panel-content'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const openCheckRunDetails = vi.fn()
const patchOpenCheckRunDetails = vi.fn()
const activeWorktreeState = vi.hoisted(() => ({
  current: null as { id: string } | null
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      openCheckRunDetails,
      patchOpenCheckRunDetails
    })
}))

vi.mock('@/store/selectors', () => ({
  useActiveWorktree: () => activeWorktreeState.current
}))

let container: HTMLDivElement
let root: Root

const failingCheck: PRCheckDetail = {
  name: 'verify',
  status: 'completed',
  conclusion: 'failure',
  url: null,
  checkRunId: 42,
  workflowRunId: 7
}

const checkDetails: PRCheckRunDetails = {
  name: 'verify',
  status: 'completed',
  conclusion: 'failure',
  url: null,
  detailsUrl: null,
  startedAt: '2026-06-16T12:00:00Z',
  completedAt: '2026-06-16T12:05:00Z',
  title: 'Verify failed',
  summary: null,
  text: null,
  annotations: [],
  jobs: [
    {
      id: 1,
      name: 'test',
      status: 'completed',
      conclusion: 'failure',
      startedAt: null,
      completedAt: null,
      url: null,
      steps: [],
      logTail: 'Error: assertion failed'
    }
  ]
}

beforeEach(() => {
  activeWorktreeState.current = null
  openCheckRunDetails.mockReset()
  patchOpenCheckRunDetails.mockReset()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
})

function renderChecksList(
  props: Partial<{
    worktreeId: string
    detailsStickySurface: 'sidebar' | 'card'
    checkDetailsContextKey: string
    checks: PRCheckDetail[]
    onLoadCheckDetails: (check: PRCheckDetail) => Promise<PRCheckRunDetails | null>
  }> = {}
): void {
  act(() => {
    root.render(
      <TooltipProvider>
        <ChecksList
          checks={props.checks ?? [failingCheck]}
          checksLoading={false}
          checkDetailsContextKey={props.checkDetailsContextKey ?? 'repo:42'}
          worktreeId={props.worktreeId}
          detailsStickySurface={props.detailsStickySurface ?? 'sidebar'}
          onLoadCheckDetails={
            props.onLoadCheckDetails ??
            (async () => {
              await Promise.resolve()
              return checkDetails
            })
          }
        />
      </TooltipProvider>
    )
  })
}

describe('ChecksList expanded check details', () => {
  it('pins a contextual full-details action with the correct sticky surface', async () => {
    renderChecksList({ worktreeId: 'wt-child-1', detailsStickySurface: 'card' })

    await act(async () => {
      await Promise.resolve()
    })

    const stickyBar = container.querySelector('.sticky.top-0')
    expect(stickyBar).not.toBeNull()
    expect(stickyBar?.className).toContain('bg-card/95')
    expect(stickyBar?.textContent).toContain('verify')
    expect(stickyBar?.textContent).toContain('View full logs')
    expect(container.innerHTML).toContain('lucide-panel-right')
    expect(container.innerHTML).toContain('data-variant="outline"')
  })

  it('uses the sidebar sticky surface by default in the hosted checks panel', async () => {
    activeWorktreeState.current = { id: 'wt-active-1' }
    renderChecksList()

    await act(async () => {
      await Promise.resolve()
    })

    const stickyBar = container.querySelector('.sticky.top-0')
    expect(stickyBar?.className).toContain('bg-sidebar/95')
  })

  it('falls back to the active worktree when no worktree override is provided', async () => {
    activeWorktreeState.current = { id: 'wt-active-1' }
    renderChecksList()

    await act(async () => {
      await Promise.resolve()
    })

    const button = [...container.querySelectorAll('button')].find((candidate) =>
      candidate.textContent?.includes('View full logs')
    )
    expect(button).toBeDefined()

    act(() => {
      button!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(openCheckRunDetails).toHaveBeenCalledWith(
      'wt-active-1',
      'repo:42',
      failingCheck,
      expect.objectContaining({
        details: checkDetails,
        loading: false,
        error: null
      })
    )
  })

  it('opens full details on the provided worktree instead of the active worktree', async () => {
    activeWorktreeState.current = { id: 'wt-active-1' }
    renderChecksList({ worktreeId: 'wt-attached-9' })

    await act(async () => {
      await Promise.resolve()
    })

    const button = [...container.querySelectorAll('button')].find((candidate) =>
      candidate.textContent?.includes('View full logs')
    )
    expect(button).toBeDefined()

    act(() => {
      button!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(openCheckRunDetails).toHaveBeenCalledWith(
      'wt-attached-9',
      'repo:42',
      failingCheck,
      expect.objectContaining({
        details: checkDetails,
        loading: false,
        error: null
      })
    )
  })

  it('keeps the generic label while inline details are still loading', async () => {
    renderChecksList({
      worktreeId: 'wt-child-1',
      onLoadCheckDetails: () => new Promise(() => {})
    })

    await act(async () => {
      await Promise.resolve()
    })

    const stickyBar = container.querySelector('.sticky.top-0')
    expect(stickyBar?.textContent).toContain('View full details')
    expect(stickyBar?.textContent).not.toContain('View full logs')
  })

  it('finishes the full-details tab when its sidebar unmounts during loading', async () => {
    let resolveDetails: (details: PRCheckRunDetails) => void = () => {}
    const request = new Promise<PRCheckRunDetails>((resolve) => {
      resolveDetails = resolve
    })
    renderChecksList({ worktreeId: 'wt-child-1', onLoadCheckDetails: () => request })

    await act(async () => {
      await Promise.resolve()
    })
    patchOpenCheckRunDetails.mockClear()
    const button = [...container.querySelectorAll('button')].find((candidate) =>
      candidate.textContent?.includes('View full details')
    )

    act(() => {
      button!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      root.render(<div />)
    })
    await act(async () => {
      resolveDetails(checkDetails)
      await request
    })

    expect(patchOpenCheckRunDetails).toHaveBeenCalledWith(
      'wt-child-1',
      'repo:42',
      failingCheck,
      expect.objectContaining({ details: checkDetails, loading: false, error: null })
    )
  })

  it('shows a load error in the full-details tab after its sidebar unmounts', async () => {
    let rejectDetails: (error: Error) => void = () => {}
    const request = new Promise<PRCheckRunDetails>((_resolve, reject) => {
      rejectDetails = reject
    })
    renderChecksList({ worktreeId: 'wt-child-1', onLoadCheckDetails: () => request })

    await act(async () => {
      await Promise.resolve()
    })
    patchOpenCheckRunDetails.mockClear()
    const button = [...container.querySelectorAll('button')].find((candidate) =>
      candidate.textContent?.includes('View full details')
    )

    act(() => {
      button!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      root.render(<div />)
    })
    await act(async () => {
      rejectDetails(new Error('GitHub request failed'))
      await request.catch(() => undefined)
    })

    expect(patchOpenCheckRunDetails).toHaveBeenCalledWith(
      'wt-child-1',
      'repo:42',
      failingCheck,
      expect.objectContaining({ details: null, loading: false, error: 'GitHub request failed' })
    )
  })

  it('retries an inline details error', async () => {
    let resolveRetry: (details: PRCheckRunDetails) => void = () => {}
    const retryRequest = new Promise<PRCheckRunDetails>((resolve) => {
      resolveRetry = resolve
    })
    const onLoadCheckDetails = vi
      .fn<() => Promise<PRCheckRunDetails | null>>()
      .mockRejectedValueOnce(new Error('GitHub request failed'))
      .mockReturnValueOnce(retryRequest)
    renderChecksList({ onLoadCheckDetails })

    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    const retry = [...container.querySelectorAll('button')].find(
      (candidate) => candidate.textContent?.trim() === 'Retry'
    )
    retry!.focus()

    await act(async () => {
      retry!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })

    expect(onLoadCheckDetails).toHaveBeenCalledTimes(2)
    expect(document.activeElement).toBe(retry)
    expect(retry?.disabled).toBe(true)
    expect(retry?.textContent).toContain('Retrying…')
    expect(retry?.getAttribute('aria-busy')).toBe('true')
    expect(container.textContent).toContain('GitHub request failed')

    await act(async () => {
      resolveRetry(checkDetails)
      await retryRequest
    })

    expect(container.textContent).toContain('Verify failed')
  })

  it('ignores a stale inline result after returning to the same context', async () => {
    const requests: {
      resolve: (details: PRCheckRunDetails) => void
      reject: (error: Error) => void
    }[] = []
    const onLoadCheckDetails = vi.fn(
      () =>
        new Promise<PRCheckRunDetails>((resolve, reject) => {
          requests.push({ resolve, reject })
        })
    )

    renderChecksList({ checkDetailsContextKey: 'repo:A', onLoadCheckDetails })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    renderChecksList({ checkDetailsContextKey: 'repo:B', onLoadCheckDetails })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    renderChecksList({ checkDetailsContextKey: 'repo:A', onLoadCheckDetails })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(requests).toHaveLength(3)
    await act(async () => {
      requests[2]!.resolve(checkDetails)
      await Promise.resolve()
    })
    await act(async () => {
      requests[0]!.reject(new Error('stale request failed'))
      await Promise.resolve()
    })

    expect(container.textContent).toContain('Verify failed')
    expect(container.textContent).not.toContain('stale request failed')
  })

  it('uses resolved details when showing the action-required fallback hint', async () => {
    renderChecksList({
      onLoadCheckDetails: async () => ({
        ...checkDetails,
        conclusion: 'action_required',
        title: null,
        jobs: []
      })
    })

    await act(async () => {
      await Promise.resolve()
    })

    expect(container.textContent).toContain('manual action on GitHub')
    expect(container.textContent).not.toContain('No inline details are available')
  })

  it('renders the log excerpt inline instead of deferring it to the full-details tab', async () => {
    renderChecksList({ worktreeId: 'wt-child-1' })

    await act(async () => {
      await Promise.resolve()
    })

    expect(container.textContent).toContain('Error: assertion failed')
    expect(container.textContent).not.toContain('Log tail available in full details')
  })

  // Regression for #7732: manual/created GitLab jobs carry no web_url and no GitHub
  // handles, so the panel used to short-circuit before ever asking for their log.
  it('loads details for a GitLab job that only carries a job id', async () => {
    const gitLabCheck: PRCheckDetail = {
      name: 'deploy: production',
      status: 'completed',
      conclusion: 'failure',
      url: null,
      gitlabJobId: 987654
    }
    const onLoadCheckDetails = vi.fn(async () => ({
      ...checkDetails,
      name: gitLabCheck.name,
      jobs: [{ ...checkDetails.jobs[0]!, id: 987654, logTail: 'ERROR: Job failed: exit code 1' }]
    }))

    renderChecksList({ worktreeId: 'wt-child-1', checks: [gitLabCheck], onLoadCheckDetails })

    await act(async () => {
      await Promise.resolve()
    })

    expect(onLoadCheckDetails).toHaveBeenCalledWith(gitLabCheck)
    expect(container.textContent).toContain('ERROR: Job failed: exit code 1')
    expect(container.textContent).not.toContain('No inline details are available')
    expect(container.querySelector('.sticky.top-0')?.textContent).toContain('View full logs')
  })

  // GitLab trace fetches fail for reasons GitHub's never do (auth, 404, self-hosted
  // host resolution) and the panel has no retry button, so a transient failure must
  // not pin its error on the row for the rest of the session.
  it('retries a failed detail load once the check state moves on', async () => {
    const runningCheck: PRCheckDetail = {
      name: 'test: unit',
      status: 'in_progress',
      conclusion: 'failure',
      url: null,
      gitlabJobId: 5150
    }
    const onLoadCheckDetails = vi
      .fn<(check: PRCheckDetail) => Promise<PRCheckRunDetails | null>>()
      .mockRejectedValueOnce(new Error('401 Unauthorized'))
      .mockResolvedValueOnce({
        ...checkDetails,
        name: runningCheck.name,
        status: 'completed',
        conclusion: 'failure',
        jobs: [{ ...checkDetails.jobs[0]!, id: 5150, logTail: 'ERROR: Job failed: exit code 1' }]
      })

    renderChecksList({ worktreeId: 'wt-child-1', checks: [runningCheck], onLoadCheckDetails })
    await act(async () => {
      await Promise.resolve()
    })

    expect(container.textContent).toContain('401 Unauthorized')
    expect(onLoadCheckDetails).toHaveBeenCalledTimes(1)

    const finishedCheck: PRCheckDetail = { ...runningCheck, status: 'completed' }
    renderChecksList({ worktreeId: 'wt-child-1', checks: [finishedCheck], onLoadCheckDetails })
    await act(async () => {
      await Promise.resolve()
    })

    expect(onLoadCheckDetails).toHaveBeenCalledTimes(2)
    expect(container.textContent).not.toContain('401 Unauthorized')
    expect(container.textContent).toContain('ERROR: Job failed: exit code 1')
  })

  // A running GitLab job has no trace yet, so the first load legitimately resolves to
  // null — without re-arming, the row stays "no inline details" after the job finishes.
  it('retries a detail load that resolved to null once the check state moves on', async () => {
    const runningCheck: PRCheckDetail = {
      name: 'test: unit',
      status: 'in_progress',
      conclusion: 'failure',
      url: null,
      gitlabJobId: 5150
    }
    const onLoadCheckDetails = vi
      .fn<(check: PRCheckDetail) => Promise<PRCheckRunDetails | null>>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        ...checkDetails,
        name: runningCheck.name,
        jobs: [{ ...checkDetails.jobs[0]!, id: 5150, logTail: 'ERROR: Job failed: exit code 1' }]
      })

    renderChecksList({ worktreeId: 'wt-child-1', checks: [runningCheck], onLoadCheckDetails })
    await act(async () => {
      await Promise.resolve()
    })

    expect(onLoadCheckDetails).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain('No inline details are available')

    const finishedCheck: PRCheckDetail = { ...runningCheck, status: 'completed' }
    renderChecksList({ worktreeId: 'wt-child-1', checks: [finishedCheck], onLoadCheckDetails })
    await act(async () => {
      await Promise.resolve()
    })

    expect(onLoadCheckDetails).toHaveBeenCalledTimes(2)
    expect(container.textContent).not.toContain('No inline details are available')
    expect(container.textContent).toContain('ERROR: Job failed: exit code 1')
  })

  it('keeps a failed detail load pinned while the check state is unchanged', async () => {
    const onLoadCheckDetails = vi
      .fn<(check: PRCheckDetail) => Promise<PRCheckRunDetails | null>>()
      .mockRejectedValue(new Error('401 Unauthorized'))
    const gitLabCheck: PRCheckDetail = {
      name: 'test: unit',
      status: 'completed',
      conclusion: 'failure',
      url: null,
      gitlabJobId: 5150
    }

    renderChecksList({ worktreeId: 'wt-child-1', checks: [gitLabCheck], onLoadCheckDetails })
    await act(async () => {
      await Promise.resolve()
    })
    // Re-render with an equal-but-new row array, as every 30s poll tick does.
    renderChecksList({ worktreeId: 'wt-child-1', checks: [{ ...gitLabCheck }], onLoadCheckDetails })
    await act(async () => {
      await Promise.resolve()
    })

    // Why: re-arming on row identity alone would refetch on every poll tick.
    expect(onLoadCheckDetails).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain('401 Unauthorized')
  })
})
