// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceActivationRecoverySurface } from './WorkspaceActivationRecoverySurface'
import {
  publishWorkspaceActivationRecoveryPresentation,
  resetWorkspaceActivationRecoveryPresentationsForTests
} from '@/lib/workspace-activation-recovery-presentation'

const WORKSPACE_KEY = 'worktree-1'

afterEach(() => {
  cleanup()
  resetWorkspaceActivationRecoveryPresentationsForTests()
})

describe('WorkspaceActivationRecoverySurface', () => {
  it('renders a target-scoped actionable failure without adding a tab', () => {
    const retry = vi.fn()
    publishWorkspaceActivationRecoveryPresentation({
      workspaceKey: WORKSPACE_KEY,
      executionHostId: 'local',
      attemptId: 'failure-1',
      kind: 'producer-failed',
      detail: 'Agent executable was not found.',
      retry
    })

    render(
      <WorkspaceActivationRecoverySurface worktreeId={WORKSPACE_KEY} executionHostId="local" />
    )

    expect(screen.getByRole('alert').getAttribute('data-workspace-activation-recovery')).toBe(
      'producer-failed'
    )
    expect(screen.getByText('Agent executable was not found.')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(retry).toHaveBeenCalledOnce()
  })

  it('renders bounded recovery progress as non-tab workspace content', () => {
    publishWorkspaceActivationRecoveryPresentation({
      workspaceKey: WORKSPACE_KEY,
      executionHostId: 'local',
      attemptId: 'progress-1',
      kind: 'recovering',
      retry: vi.fn()
    })

    render(
      <WorkspaceActivationRecoverySurface worktreeId={WORKSPACE_KEY} executionHostId="local" />
    )

    expect(screen.getByRole('status').getAttribute('data-workspace-activation-recovery')).toBe(
      'recovering'
    )
    expect(screen.queryByRole('tab')).toBeNull()
  })

  it.each([
    ['blocked', 'Workspace recovery is paused'],
    ['unexpected', 'Workspace recovery failed']
  ] as const)('distinguishes %s recovery copy', (kind, title) => {
    publishWorkspaceActivationRecoveryPresentation({
      workspaceKey: WORKSPACE_KEY,
      executionHostId: 'local',
      attemptId: `${kind}-1`,
      kind,
      retry: vi.fn()
    })

    render(
      <WorkspaceActivationRecoverySurface worktreeId={WORKSPACE_KEY} executionHostId="local" />
    )

    expect(screen.getByRole('heading', { name: title })).not.toBeNull()
  })
})
