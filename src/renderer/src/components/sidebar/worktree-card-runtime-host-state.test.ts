// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { RuntimeEnvironmentStatus } from '@/store/slices/runtime-status'

const state: Record<string, unknown> = {}

vi.mock('@/store', () => ({
  useAppStore: (selector: (value: unknown) => unknown) => selector(state)
}))

vi.mock('@/runtime/runtime-environment-ssh-state', () => ({
  hydrateRuntimeEnvironmentSshState: vi.fn(() => Promise.resolve())
}))

import { useWorktreeCardFoundation } from './use-worktree-card-foundation'

const ENVIRONMENT_ID = 'c8239d89-27a3-4c9b-948d-18afed33030d'

function setRuntimeStatus(entry: RuntimeEnvironmentStatus | undefined): void {
  const statuses = new Map<string, RuntimeEnvironmentStatus>()
  if (entry) {
    statuses.set(ENVIRONMENT_ID, entry)
  }
  state.runtimeStatusByEnvironmentId = statuses
}

function readIsRuntimeDisconnected(): boolean {
  const { result } = renderHook(() =>
    useWorktreeCardFoundation({
      worktree: { id: 'worktree-1', repoId: 'repo-1' },
      // A folder workspace and a git worktree reach the glyph through the same
      // repo host id, so one case covers both.
      repo: { id: 'repo-1', executionHostId: `runtime:${ENVIRONMENT_ID}` }
    } as never)
  )
  return result.current.isRuntimeDisconnected
}

describe('worktree card runtime host state', () => {
  beforeEach(() => {
    Object.assign(state, {
      openModal: vi.fn(),
      openTaskPage: vi.fn(),
      openAutomationsPage: vi.fn(),
      setPendingAutomationRunNavigation: vi.fn(),
      updateWorktreeMeta: vi.fn(),
      deleteFolderWorkspace: vi.fn(),
      setActiveWorktree: vi.fn(),
      setRenamingWorktreeId: vi.fn(),
      fetchHostedReviewForBranch: vi.fn(),
      fetchIssue: vi.fn(),
      fetchLinearIssue: vi.fn(),
      renamingWorktreeId: null,
      settings: {},
      worktreeCardProperties: {},
      projectGroups: [],
      deleteStateByWorktreeId: {},
      gitConflictOperationByWorktree: {},
      remoteBranchConflictByWorktreeId: {},
      workspacePortScan: null,
      runtimeEnvironments: [{ id: ENVIRONMENT_ID, name: 'honey-mac' }]
    })
    setRuntimeStatus(undefined)
  })

  it('dims the card only once a probe reports the host unreachable', () => {
    setRuntimeStatus({ status: null, checkedAt: 1 })

    expect(readIsRuntimeDisconnected()).toBe(true)
  })

  it('leaves a host that has not been probed yet undimmed', () => {
    // Why: no entry means "never checked". Reading raw truthiness painted the
    // destructive glyph over every remote card between boot and the first probe.
    expect(readIsRuntimeDisconnected()).toBe(false)
  })

  it('leaves a reachable host undimmed', () => {
    setRuntimeStatus({
      status: {
        runtimeId: 'honey-mac-runtime',
        graphStatus: 'ready'
      } as never,
      checkedAt: 1
    })

    expect(readIsRuntimeDisconnected()).toBe(false)
  })

  it('does not call a re-attaching host disconnected', () => {
    // Why: docs/reference/ssh-execution-boundary.md — a reconnecting transport is
    // unverifiable, not exited, and the shared derivation already says so.
    setRuntimeStatus({
      status: {
        runtimeId: 'honey-mac-runtime',
        graphStatus: 'ready',
        remoteControl: { state: 'reconnecting' }
      } as never,
      checkedAt: 1
    })

    expect(readIsRuntimeDisconnected()).toBe(false)
  })

  it('still reports a host whose remote control closed with an error', () => {
    // Deliberate: the status bar and Settings > Available Hosts already read this host as
    // disconnected, so the sidebar was the outlier. A closed channel that recorded a lastError is
    // the host's own report, not silence — and the recovery loop now retries it (#16518 review b1).

    setRuntimeStatus({
      status: {
        runtimeId: 'honey-mac-runtime',
        graphStatus: 'ready',
        remoteControl: { state: 'closed', lastError: 'socket closed' }
      } as never,
      checkedAt: 1
    })

    expect(readIsRuntimeDisconnected()).toBe(true)
  })
})
