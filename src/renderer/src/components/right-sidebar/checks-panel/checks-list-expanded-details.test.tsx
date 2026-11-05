// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { PRCheckDetail, PRCheckRunDetails } from '../../../../../shared/github/check-types'
import { ChecksList } from './presentation/checks-list'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const openCheckRunDetails = vi.fn()
const patchOpenCheckRunDetails = vi.fn()
const activeWorktreeState = vi.hoisted(() => ({
  current: null as { id: string } | null
}))

vi.mock('@/store/index', () => ({
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
    checksError: string
    onLoadCheckDetails: (check: PRCheckDetail) => Promise<PRCheckRunDetails | null>
  }> = {}
): void {
  act(() => {
    root.render(
      <TooltipProvider>
        <ChecksList
          checks={props.checks ?? [failingCheck]}
          checksError={props.checksError}
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

  // No retry button exists; state changes must rearm transient GitLab trace failures.
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
})
