// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { PRCheckDetail, PRCheckRunDetails } from '../../../../shared/types'
import { ChecksList } from './checks-panel-content'

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
})
