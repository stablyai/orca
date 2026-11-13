// @vitest-environment happy-dom
// A cloud create's billing refusal is a precondition, not an error: its sidebar status reads in
// muted text (the glyph carries the state); a real failure stays red.
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { retryMock } = vi.hoisted(() => ({ retryMock: vi.fn() }))
vi.mock('@/lib/workspace/creation/worktree-creation-flow', () => ({
  retryBackgroundWorktreeCreation: retryMock
}))
import { useAppStore } from '@/store'
import { githubCreateRequest } from '@/lib/orca-cloud/start-cloud-workspace-from-github'
import type { PendingWorktreeCreation } from '@/lib/workspace/creation/pending-worktree-creation'
import { PendingWorktreeRow } from './PendingWorktreeRow'

afterEach(cleanup)

function failed(
  errorCode: string | undefined,
  log: string,
  error: string,
  creationId = 'c'
): PendingWorktreeCreation {
  return {
    creationId,
    phase: 'provisioning-vm',
    status: 'error',
    startedAt: 1,
    indeterminate: false,
    loaderVisible: true,
    error,
    ...(errorCode ? { errorCode } : {}),
    provisioningLog: log,
    request: githubCreateRequest({
      repoUrl: 'https://github.com/acme/web',
      fullName: 'acme/web',
      prompt: 'Fix login',
      agent: null
    })
  }
}

function statusLine(entry: PendingWorktreeCreation): HTMLElement {
  useAppStore.setState({ pendingWorktreeCreations: { c: entry }, repos: [] })
  render(<PendingWorktreeRow creationId="c" repoName={null} />)
  const line = screen.getByText('Fix login').nextElementSibling
  if (!(line instanceof HTMLElement)) {
    throw new Error('no status line')
  }
  return line
}

describe('pending row status colour', () => {
  it('billing refusal: muted', () => {
    const line = statusLine(
      failed(
        'cloudPlanRequired',
        '[orca-cloud] provisioning\nOrca Cloud: included_hours_exhausted',
        'Orca Cloud workspaces need a plan with cloud hours.'
      )
    )
    expect(line.className).toContain('text-muted-foreground')
    expect(line.className).not.toContain('text-destructive')
  })

  it('a real failure: red', () => {
    const line = statusLine(failed(undefined, '[orca-cloud] provisioning', 'fetch failed'))
    expect(line.className).toContain('text-destructive')
  })
})

// REFUSED-CREATE-ROW-STICKY: a refused create keeps its row (and prompt) with the reason, Retry and
// Dismiss; starting another create replaces it; a slot freeing up alone never clears it.
const AT_LIMIT = () =>
  failed(
    'cloudConcurrencyLimit',
    '[orca-cloud] provisioning\nOrca Cloud: concurrency_limit',
    'You’re at your limit of running sandboxes.',
    'refused'
  )

describe('a refused create row', () => {
  it('shows the reason with Retry and Dismiss', () => {
    useAppStore.setState({ pendingWorktreeCreations: { refused: AT_LIMIT() }, repos: [] })
    render(<PendingWorktreeRow creationId="refused" repoName={null} />)
    fireEvent.click(screen.getByRole('button', { name: 'Retry Fix login' }))
    expect(retryMock).toHaveBeenCalledWith('refused')
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss Fix login' }))
    expect(useAppStore.getState().pendingWorktreeCreations.refused).toBeUndefined()
  })

  it('is replaced when another create starts, but a real failure and running creates stay', () => {
    const realFailure = failed(undefined, '[orca-cloud] provisioning', 'fetch failed', 'broken')
    useAppStore.setState({
      pendingWorktreeCreations: { refused: AT_LIMIT(), broken: realFailure },
      repos: []
    })
    useAppStore.getState().beginPendingWorktreeCreation({
      ...failed(undefined, '', '', 'next'),
      status: 'creating',
      error: undefined
    })
    const left = Object.keys(useAppStore.getState().pendingWorktreeCreations).sort()
    expect(left).toEqual(['broken', 'next'])
  })

  it('stays put until the person acts: nothing else clears it', () => {
    useAppStore.setState({ pendingWorktreeCreations: { refused: AT_LIMIT() }, repos: [] })
    useAppStore.getState().updatePendingWorktreeCreation('refused', { loaderVisible: false })
    expect(useAppStore.getState().pendingWorktreeCreations.refused).toBeDefined()
  })
})
