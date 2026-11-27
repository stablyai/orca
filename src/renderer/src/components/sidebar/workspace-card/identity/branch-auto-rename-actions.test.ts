import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WORKTREE_AUTO_NAME_ACTIONS_RUNTIME_CAPABILITY } from '../../../../../../shared/remote-runtime/protocol/worktree-runtime-capabilities'
import {
  canDismissAutoName,
  dismissAutoName,
  getAutoNameRetryAvailability,
  retryAutoName,
  waitForAutoNameAttempt
} from './branch-auto-rename-actions'

// `old` predates the auto-name actions; `new` serves them.
const hosts: Record<string, readonly string[]> = {
  old: [],
  new: [WORKTREE_AUTO_NAME_ACTIONS_RUNTIME_CAPABILITY]
}
const owners: Record<string, { kind: 'local' } | { kind: 'environment'; environmentId: string }> = {
  'repo::/local': { kind: 'local' },
  'repo::/old': { kind: 'environment', environmentId: 'old' },
  'repo::/new': { kind: 'environment', environmentId: 'new' }
}
const calls: { method: string; params: unknown }[] = []

vi.mock('@/store/index', () => ({ useAppStore: { getState: () => ({}) } }))
vi.mock('@/store/slices/worktrees/listing/worktree-owner-target', () => ({
  tryRuntimeTargetForWorktreeOwner: (_state: unknown, worktreeId: string) =>
    owners[worktreeId] ?? null
}))
vi.mock('@/runtime/rpc/compatibility/runtime-capability-proof', () => ({
  runtimeEnvironmentSupportsCapability: async (environmentId: string, capability: string) =>
    hosts[environmentId]?.includes(capability) === true
}))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({
  callRuntimeRpc: async (_target: unknown, method: string, params: unknown) => {
    calls.push({ method, params })
    return method.endsWith('wait')
      ? { attemptId: 42, outcome: { kind: 'failed' }, finishedAt: 2 }
      : method.endsWith('dismiss')
        ? { dismissed: true }
        : method.endsWith('availability')
          ? { available: true, runningAttemptId: null }
          : { attemptId: 7, outcome: { kind: 'renamed' }, finishedAt: 1 }
  }
}))

const local = {
  getBranchAutoRenameRetryAvailability: vi.fn(async () => ({
    available: true,
    runningAttemptId: null
  })),
  retryBranchAutoRename: vi.fn(),
  dismissBranchAutoRename: vi.fn(async () => ({ dismissed: true }))
}
vi.stubGlobal('window', { api: { worktrees: local } })

const at = (path: string) => ({ worktreeId: `repo::/${path}`, executionHostId: undefined })

beforeEach(() => {
  calls.length = 0
  vi.clearAllMocks()
})

describe('auto-name actions routing', () => {
  it('sends a paired server its own workspace’s actions only when it serves them', async () => {
    expect(await getAutoNameRetryAvailability(at('old'))).toEqual({
      available: false,
      runningAttemptId: null
    })
    expect(await dismissAutoName(at('old'))).toEqual({ dismissed: false })
    expect(await canDismissAutoName(at('old'))).toBe(false)
    expect((await retryAutoName(at('old'))).outcome).toEqual({
      kind: 'ineligible',
      reason: 'unavailable'
    })
    expect(calls).toEqual([])

    expect(await canDismissAutoName(at('new'))).toBe(true)
    expect(await dismissAutoName(at('new'))).toEqual({ dismissed: true })
    expect((await retryAutoName(at('new'))).outcome).toEqual({ kind: 'renamed' })
    expect(calls).toEqual([
      { method: 'worktree.autoName.dismiss', params: { worktreeId: 'repo::/new' } },
      { method: 'worktree.autoName.retry', params: { worktreeId: 'repo::/new' } }
    ])
    expect(local.dismissBranchAutoRename).not.toHaveBeenCalled()
  })

  it('waits on a paired server’s running attempt through the same gate', async () => {
    expect(await waitForAutoNameAttempt(at('old'), 42)).toBeNull()
    expect(calls).toEqual([])
    expect(await waitForAutoNameAttempt(at('new'), 42)).toEqual({
      attemptId: 42,
      outcome: { kind: 'failed' },
      finishedAt: 2
    })
    expect(calls).toEqual([
      { method: 'worktree.autoName.wait', params: { worktreeId: 'repo::/new', attemptId: 42 } }
    ])
  })

  it('keeps this app’s own workspaces on the desktop bridge', async () => {
    expect(await dismissAutoName(at('local'))).toEqual({ dismissed: true })
    expect(local.dismissBranchAutoRename).toHaveBeenCalledWith(at('local'))
    expect(calls).toEqual([])
  })
})
