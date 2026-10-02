import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import type { Repo } from '../../../shared/repo-types'

const mocks = vi.hoisted(() => ({
  ensureHooksConfirmed: vi.fn(),
  resolveDirectSetupDecision: vi.fn(),
  findForkWorktreeRepo: vi.fn(),
  forkWorktreeOwnerSettings: vi.fn(() => ({ activeRuntimeEnvironmentId: null }))
}))
vi.mock('@/lib/ensure-hooks-confirmed', () => ({
  ensureHooksConfirmed: mocks.ensureHooksConfirmed
}))
vi.mock('@/lib/launch-work-item-direct-preflight', () => ({
  resolveDirectSetupDecision: mocks.resolveDirectSetupDecision
}))
vi.mock('./agent-session-fork-source-repo', () => ({
  findForkWorktreeRepo: mocks.findForkWorktreeRepo,
  forkWorktreeOwnerSettings: mocks.forkWorktreeOwnerSettings
}))

const { resolveForkSetupDecision } = await import('./agent-session-fork-setup-decision')

const repo: Repo = {
  id: 'repo',
  path: '/r',
  displayName: 'repo',
  badgeColor: '#000',
  addedAt: 0,
  connectionId: 'ssh-1'
}
const source = { repoId: 'repo', hostId: 'ssh:ssh-1' as const, runtimeOwnerEnvironmentId: 'env-1' }
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the resolver only hands state to mocked collaborators.
const state = {} as AppState

beforeEach(() => {
  vi.clearAllMocks()
  mocks.findForkWorktreeRepo.mockReturnValue(repo)
  mocks.resolveDirectSetupDecision.mockResolvedValue({ kind: 'decided', decision: 'run' })
  mocks.ensureHooksConfirmed.mockResolvedValue('run')
})

describe('resolveForkSetupDecision', () => {
  it('runs setup when the repo policy runs it and the user trusts orca.yaml', async () => {
    await expect(resolveForkSetupDecision(state, source)).resolves.toBe('run')
    expect(mocks.ensureHooksConfirmed).toHaveBeenCalledExactlyOnceWith(
      state,
      'repo',
      'setup',
      'ssh:ssh-1',
      'env-1'
    )
  })

  it('skips setup when orca.yaml is not trusted', async () => {
    mocks.ensureHooksConfirmed.mockResolvedValue('skip')
    await expect(resolveForkSetupDecision(state, source)).resolves.toBe('skip')
  })

  it('still asks for trust when only default-tab commands could run', async () => {
    mocks.resolveDirectSetupDecision.mockResolvedValue({ kind: 'decided', decision: 'inherit' })
    mocks.ensureHooksConfirmed.mockResolvedValue('skip')
    await expect(resolveForkSetupDecision(state, source)).resolves.toBe('skip')
    expect(mocks.ensureHooksConfirmed).toHaveBeenCalledTimes(1)
  })

  it("creates without setup for an 'ask' repo, without a trust prompt", async () => {
    mocks.resolveDirectSetupDecision.mockResolvedValue({ kind: 'needs-modal' })
    await expect(resolveForkSetupDecision(state, source)).resolves.toBe('skip')
    expect(mocks.ensureHooksConfirmed).not.toHaveBeenCalled()
  })

  it('does not prompt when the repo policy already skips setup', async () => {
    mocks.resolveDirectSetupDecision.mockResolvedValue({ kind: 'decided', decision: 'skip' })
    await expect(resolveForkSetupDecision(state, source)).resolves.toBe('skip')
    expect(mocks.ensureHooksConfirmed).not.toHaveBeenCalled()
  })

  it('fails closed when the repo record is missing', async () => {
    mocks.findForkWorktreeRepo.mockReturnValue(null)
    await expect(resolveForkSetupDecision(state, source)).resolves.toBe('skip')
    expect(mocks.resolveDirectSetupDecision).not.toHaveBeenCalled()
  })
})
