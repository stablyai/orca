import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceActivationIdentity } from './worktree-activation-recovery'
import {
  readWorkspaceSurfaceProducerEntries,
  registerWorkspaceSurfaceProducer,
  resetWorkspaceSurfaceProducersForTests
} from './workspace-surface-production'
import { startWorkspaceActivationSurfaceProducer } from './workspace-activation-surface-producer'

const mocks = vi.hoisted(() => ({
  evidence: vi.fn(),
  gate: vi.fn(),
  hasSleeping: vi.fn(),
  hasTombstone: vi.fn(),
  isRouteCurrent: vi.fn(),
  readSurface: vi.fn(),
  runtimeRevision: vi.fn(),
  seed: vi.fn(),
  state: {}
}))

vi.mock('@/store', () => ({
  useAppStore: { getState: () => mocks.state }
}))
vi.mock('./workspace-execution-evidence', () => ({
  resolveWorkspaceExecutionEvidence: mocks.evidence
}))
vi.mock('./workspace-activation-recovery-state', () => ({
  canInspectAgentActivationInventory: () => true,
  hasLiveActivationTerminalTombstone: mocks.hasTombstone,
  isActivationExecutionRouteCurrent: mocks.isRouteCurrent,
  readActivationRenderableSurface: mocks.readSurface,
  WORKSPACE_ACTIVATION_RECOVERY_DEADLINE_MS: 30_000
}))
vi.mock('./worktree-agent-activation-gate', () => ({
  gateWorktreeAgentActivation: mocks.gate
}))
vi.mock('./worktree-agent-activation-claims', () => ({
  workspaceHasSleepingAgentSessions: mocks.hasSleeping
}))
vi.mock('./worktree-initial-terminal-seeding', () => ({
  ensureWorktreeHasInitialTerminal: mocks.seed
}))
vi.mock('@/runtime/runtime-environment-revision', () => ({
  getRuntimeEnvironmentRevision: mocks.runtimeRevision
}))

const IDENTITY: WorkspaceActivationIdentity = {
  workspaceKey: 'worktree-1',
  executionHostId: 'local',
  runtimeEnvironmentId: null,
  attemptId: 'activation-1'
}

beforeEach(() => {
  resetWorkspaceSurfaceProducersForTests()
  mocks.evidence.mockReset().mockReturnValue('exited')
  mocks.gate.mockReset().mockResolvedValue('empty')
  mocks.hasSleeping.mockReset().mockReturnValue(false)
  mocks.hasTombstone.mockReset().mockReturnValue(false)
  mocks.isRouteCurrent.mockReset().mockReturnValue(true)
  mocks.readSurface.mockReset().mockReturnValue(null)
  mocks.runtimeRevision.mockReset().mockReturnValue(undefined)
  mocks.seed.mockReset().mockReturnValue(null)
})

describe('workspace activation surface producer', () => {
  it('contains an initial inventory error as producer settlement', () => {
    mocks.readSurface.mockImplementation(() => {
      throw new Error('inventory unavailable')
    })

    expect(() =>
      startWorkspaceActivationSurfaceProducer(IDENTITY, { mode: 'explicit' })
    ).not.toThrow()
    expect(readWorkspaceSurfaceProducerEntries(IDENTITY)).toMatchObject([
      { result: { kind: 'unexpected', reason: 'inventory unavailable' } }
    ])
  })

  it('does not let an old failure mask a later inventory error on retry', () => {
    const failedProducer = registerWorkspaceSurfaceProducer(IDENTITY)
    failedProducer.failed('old launch failed')
    mocks.readSurface.mockImplementation(() => {
      throw new Error('inventory unavailable')
    })

    startWorkspaceActivationSurfaceProducer(
      { ...IDENTITY, attemptId: 'activation-2' },
      { mode: 'explicit', supersedeSettledOwnership: true }
    )

    expect(readWorkspaceSurfaceProducerEntries(IDENTITY)).toMatchObject([
      { result: { kind: 'unexpected', reason: 'inventory unavailable' } }
    ])
  })

  it('owns shell creation after the route-scoped gate proves it safe', async () => {
    mocks.readSurface
      .mockReturnValueOnce(null)
      .mockReturnValueOnce(null)
      .mockReturnValueOnce({ id: 'seeded-tab', type: 'terminal' })
    mocks.seed.mockReturnValue('seeded-tab')

    startWorkspaceActivationSurfaceProducer(IDENTITY, { mode: 'explicit' })

    await vi.waitFor(() =>
      expect(readWorkspaceSurfaceProducerEntries(IDENTITY)).toMatchObject([
        { result: { kind: 'materialized', surface: { kind: 'tab', id: 'seeded-tab' } } }
      ])
    )
    expect(mocks.gate).toHaveBeenCalledWith(
      { ...IDENTITY, runtimeEnvironmentRevision: null },
      { timeoutMs: 30_000 }
    )
    expect(mocks.seed).toHaveBeenCalledOnce()
  })

  it('captures the saved runtime pairing revision in the gate route', async () => {
    mocks.runtimeRevision.mockReturnValue(17)
    const remoteIdentity: WorkspaceActivationIdentity = {
      ...IDENTITY,
      executionHostId: 'runtime:environment-1',
      runtimeEnvironmentId: 'environment-1'
    }

    startWorkspaceActivationSurfaceProducer(remoteIdentity, { mode: 'explicit' })

    await vi.waitFor(() =>
      expect(mocks.gate).toHaveBeenCalledWith(
        { ...remoteIdentity, runtimeEnvironmentRevision: 17 },
        { timeoutMs: 30_000 }
      )
    )
  })

  it('still gates sleeping-session resumption when a husk surface remains visible', async () => {
    mocks.hasSleeping.mockReturnValue(true)
    mocks.readSurface.mockReturnValue({ id: 'husk-tab', type: 'terminal' })

    startWorkspaceActivationSurfaceProducer(IDENTITY, { mode: 'explicit' })

    await vi.waitFor(() => expect(mocks.gate).toHaveBeenCalledOnce())
    expect(readWorkspaceSurfaceProducerEntries(IDENTITY)).toMatchObject([
      { result: { kind: 'materialized', surface: { kind: 'tab', id: 'husk-tab' } } }
    ])
  })

  it('publishes a blocked settlement without starting a writer', async () => {
    mocks.gate.mockResolvedValue('blocked')

    startWorkspaceActivationSurfaceProducer(IDENTITY, { mode: 'explicit' })

    await vi.waitFor(() =>
      expect(readWorkspaceSurfaceProducerEntries(IDENTITY)).toMatchObject([
        { result: { kind: 'blocked' } }
      ])
    )
    expect(mocks.seed).not.toHaveBeenCalled()
  })

  it.each(['adopted', 'structured', 'resumed'] as const)(
    'does not seed before a %s gate outcome becomes visible',
    async (outcome) => {
      mocks.gate.mockResolvedValue(outcome)

      startWorkspaceActivationSurfaceProducer(IDENTITY, { mode: 'explicit' })

      await vi.waitFor(() =>
        expect(readWorkspaceSurfaceProducerEntries(IDENTITY)).toMatchObject([
          { result: { kind: 'unverifiable' } }
        ])
      )
      expect(mocks.seed).not.toHaveBeenCalled()
    }
  )

  it('lets a later activation replace settled recovery ownership', async () => {
    mocks.gate.mockResolvedValueOnce('blocked').mockResolvedValueOnce('empty')
    mocks.readSurface
      .mockReturnValueOnce(null)
      .mockReturnValueOnce(null)
      .mockReturnValueOnce(null)
      .mockReturnValueOnce({ id: 'retry-tab', type: 'terminal' })
    mocks.seed.mockReturnValue('retry-tab')
    startWorkspaceActivationSurfaceProducer(IDENTITY, { mode: 'explicit' })
    await vi.waitFor(() =>
      expect(readWorkspaceSurfaceProducerEntries(IDENTITY)[0]?.result?.kind).toBe('blocked')
    )

    startWorkspaceActivationSurfaceProducer(
      { ...IDENTITY, attemptId: 'activation-2' },
      { mode: 'explicit' }
    )

    await vi.waitFor(() =>
      expect(readWorkspaceSurfaceProducerEntries(IDENTITY)).toMatchObject([
        { result: { kind: 'materialized', surface: { id: 'retry-tab' } } }
      ])
    )
    expect(mocks.gate).toHaveBeenCalledTimes(2)
  })

  it('supersedes a settled generic create failure on retry and starts the next gate', async () => {
    const failedProducer = registerWorkspaceSurfaceProducer(IDENTITY)
    failedProducer.failed('launch failed')

    startWorkspaceActivationSurfaceProducer(
      { ...IDENTITY, attemptId: 'activation-2' },
      { mode: 'explicit', supersedeSettledOwnership: true }
    )

    await vi.waitFor(() => expect(mocks.gate).toHaveBeenCalledOnce())
    expect(
      readWorkspaceSurfaceProducerEntries(IDENTITY).map((entry) => entry.attempt.id)
    ).not.toContain(failedProducer.attempt.id)
  })

  it('keeps a concrete producer verdict when activation is not a retry', () => {
    const failedProducer = registerWorkspaceSurfaceProducer(IDENTITY)
    failedProducer.failed('launch failed')

    startWorkspaceActivationSurfaceProducer(
      { ...IDENTITY, attemptId: 'activation-2' },
      { mode: 'explicit' }
    )

    expect(mocks.gate).not.toHaveBeenCalled()
    expect(readWorkspaceSurfaceProducerEntries(IDENTITY).map((entry) => entry.attempt.id)).toEqual([
      failedProducer.attempt.id
    ])
  })

  it('supersedes a settled unverifiable attempt so Retry can run a new gate', async () => {
    const strandedProducer = registerWorkspaceSurfaceProducer(IDENTITY)
    strandedProducer.unverifiable('Orca cannot verify the execution host for this workspace.')

    startWorkspaceActivationSurfaceProducer(
      { ...IDENTITY, attemptId: 'activation-2' },
      { mode: 'explicit', supersedeSettledOwnership: true }
    )

    await vi.waitFor(() => expect(mocks.gate).toHaveBeenCalledOnce())
    expect(
      readWorkspaceSurfaceProducerEntries(IDENTITY).map((entry) => entry.attempt.id)
    ).not.toContain(strandedProducer.attempt.id)
  })

  it('leaves an unsettled producer owning the workspace', () => {
    const pendingProducer = registerWorkspaceSurfaceProducer(IDENTITY)

    startWorkspaceActivationSurfaceProducer(
      { ...IDENTITY, attemptId: 'activation-2' },
      { mode: 'explicit' }
    )

    expect(mocks.gate).not.toHaveBeenCalled()
    expect(readWorkspaceSurfaceProducerEntries(IDENTITY).map((entry) => entry.attempt.id)).toEqual([
      pendingProducer.attempt.id
    ])
  })

  it('supersedes a settled unverifiable attempt once route evidence disagrees', async () => {
    const stranded = registerWorkspaceSurfaceProducer(IDENTITY)
    stranded.unverifiable('The execution host could not be reached.')
    mocks.evidence.mockReturnValue('exited')

    startWorkspaceActivationSurfaceProducer(
      { ...IDENTITY, attemptId: 'activation-2' },
      { mode: 'explicit' }
    )

    await vi.waitFor(() => expect(mocks.gate).toHaveBeenCalledOnce())
    expect(
      readWorkspaceSurfaceProducerEntries(IDENTITY).map((entry) => entry.attempt.id)
    ).not.toContain(stranded.attempt.id)
  })

  it('keeps a settled unverifiable attempt while the host is still unverifiable', () => {
    const stranded = registerWorkspaceSurfaceProducer(IDENTITY)
    stranded.unverifiable('The execution host could not be reached.')
    mocks.evidence.mockReturnValue('unverifiable')

    startWorkspaceActivationSurfaceProducer(
      { ...IDENTITY, attemptId: 'activation-2' },
      { mode: 'explicit' }
    )

    expect(mocks.gate).not.toHaveBeenCalled()
    expect(readWorkspaceSurfaceProducerEntries(IDENTITY).map((entry) => entry.attempt.id)).toEqual([
      stranded.attempt.id
    ])
  })

  it('discards stale route ownership without starting a writer', async () => {
    mocks.gate.mockResolvedValue('stale')

    startWorkspaceActivationSurfaceProducer(IDENTITY, { mode: 'explicit' })

    await vi.waitFor(() => expect(readWorkspaceSurfaceProducerEntries(IDENTITY)).toEqual([]))
    expect(mocks.seed).not.toHaveBeenCalled()
  })

  it('rechecks the route after a gate settles before starting a writer', async () => {
    let settleGate!: (outcome: 'empty') => void
    mocks.gate.mockReturnValue(
      new Promise((resolve) => {
        settleGate = resolve
      })
    )

    startWorkspaceActivationSurfaceProducer(IDENTITY, { mode: 'explicit' })
    mocks.isRouteCurrent.mockReturnValue(false)
    settleGate('empty')

    await vi.waitFor(() => expect(readWorkspaceSurfaceProducerEntries(IDENTITY)).toEqual([]))
    expect(mocks.seed).not.toHaveBeenCalled()
  })

  it('rechecks the route after final inventory reconciliation', async () => {
    mocks.readSurface.mockReturnValueOnce(null).mockImplementation(() => {
      mocks.isRouteCurrent.mockReturnValue(false)
      return null
    })

    startWorkspaceActivationSurfaceProducer(IDENTITY, { mode: 'explicit' })

    await vi.waitFor(() => expect(readWorkspaceSurfaceProducerEntries(IDENTITY)).toEqual([]))
    expect(mocks.seed).not.toHaveBeenCalled()
  })

  it('keeps genuinely unverifiable execution writer-free', async () => {
    mocks.evidence.mockReturnValue('unverifiable')

    startWorkspaceActivationSurfaceProducer(IDENTITY, { mode: 'explicit' })

    await vi.waitFor(() =>
      expect(readWorkspaceSurfaceProducerEntries(IDENTITY)).toMatchObject([
        { result: { kind: 'unverifiable' } }
      ])
    )
    expect(mocks.seed).not.toHaveBeenCalled()
  })

  it('preserves a startup tombstone as intentional empty', async () => {
    mocks.hasTombstone.mockReturnValue(true)

    startWorkspaceActivationSurfaceProducer(IDENTITY, { mode: 'startup' })

    await vi.waitFor(() =>
      expect(readWorkspaceSurfaceProducerEntries(IDENTITY)).toMatchObject([
        { result: { kind: 'intentional-empty' } }
      ])
    )
    expect(mocks.seed).toHaveBeenCalledOnce()
  })
})
