// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { PRCheckDetail, PRCheckRunDetails } from '../../../../shared/types'
import { ChecksList } from './checks-panel-content'

const openCheckRunDetails = vi.fn()
const patchOpenCheckRunDetails = vi.fn()

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      openCheckRunDetails,
      patchOpenCheckRunDetails
    })
}))

vi.mock('@/store/selectors', () => ({
  useActiveWorktree: () => null
}))

let container: HTMLDivElement
let root: Root

const failingCheck: PRCheckDetail = {
  name: 'verify',
  status: 'completed',
  conclusion: 'failure',
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
    detailsStickySurface: 'sidebar' | 'background'
    onLoadCheckDetails: (check: PRCheckDetail) => Promise<PRCheckRunDetails | null>
  }> = {}
): void {
  act(() => {
    root.render(
      <TooltipProvider>
        <ChecksList
          checks={[failingCheck]}
          checksLoading={false}
          checkDetailsContextKey="repo:42"
          worktreeId={props.worktreeId ?? 'wt-child-1'}
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
    renderChecksList({ detailsStickySurface: 'background' })

    await act(async () => {
      await Promise.resolve()
    })

    const stickyBar = container.querySelector('.sticky.top-0')
    expect(stickyBar).not.toBeNull()
    expect(stickyBar?.className).toContain('bg-background/95')
    expect(stickyBar?.textContent).toContain('verify')
    expect(stickyBar?.textContent).toContain('View full logs')
    expect(container.innerHTML).toContain('lucide-panel-right')
    expect(container.innerHTML).toContain('data-variant="outline"')
  })

  it('opens full details on the provided worktree instead of the active worktree', async () => {
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
})
