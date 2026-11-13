// @vitest-environment happy-dom
// A cloud create's billing refusal is a precondition, not an error: its sidebar status reads in
// muted text (the glyph carries the state); a real failure stays red.
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import { githubCreateRequest } from '@/lib/orca-cloud/start-cloud-workspace-from-github'
import type { PendingWorktreeCreation } from '@/lib/workspace/creation/pending-worktree-creation'
import { PendingWorktreeRow } from './PendingWorktreeRow'

afterEach(cleanup)

function failed(
  errorCode: string | undefined,
  log: string,
  error: string
): PendingWorktreeCreation {
  return {
    creationId: 'c',
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
