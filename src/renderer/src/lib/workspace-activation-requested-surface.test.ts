import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceActivationIdentity } from './worktree-activation-recovery'
import {
  readWorkspaceSurfaceProducerEntries,
  resetWorkspaceSurfaceProducersForTests
} from './workspace-surface-production'
import { produceRequestedWorkspaceSurface } from './workspace-activation-requested-surface'

const mocks = vi.hoisted(() => ({
  captureIds: vi.fn(),
  gate: vi.fn(),
  isRouteCurrent: vi.fn(),
  resume: vi.fn(),
  runtimeRevision: vi.fn(),
  settleSeed: vi.fn()
}))

vi.mock('./worktree-agent-activation-gate', () => ({
  gateWorktreeAgentActivation: mocks.gate
}))
vi.mock('./workspace-activation-recovery-state', () => ({
  isActivationExecutionRouteCurrent: mocks.isRouteCurrent,
  WORKSPACE_ACTIVATION_RECOVERY_DEADLINE_MS: 30_000
}))
vi.mock('@/runtime/runtime-environment-revision', () => ({
  getRuntimeEnvironmentRevision: mocks.runtimeRevision
}))
vi.mock('./worktree-activation-recovery-routing', () => ({
  captureActivationRenderableSurfaceIds: mocks.captureIds,
  settleActivationSeedProducer: mocks.settleSeed
}))
vi.mock('./resume-sleeping-agent-session', () => ({
  resumeSleepingAgentSessionsForWorktree: mocks.resume
}))

const WORKTREE_IDENTITY: WorkspaceActivationIdentity = {
  workspaceKey: 'worktree:wt-1',
  executionHostId: 'ssh:box',
  runtimeEnvironmentId: null,
  attemptId: 'requested-1'
}

const FOLDER_IDENTITY: WorkspaceActivationIdentity = {
  ...WORKTREE_IDENTITY,
  workspaceKey: 'folder:folder-1'
}

function readResult(identity: WorkspaceActivationIdentity): unknown {
  return readWorkspaceSurfaceProducerEntries(identity)[0]?.result
}

beforeEach(() => {
  resetWorkspaceSurfaceProducersForTests()
  mocks.captureIds.mockReset().mockReturnValue(new Set<string>())
  mocks.gate.mockReset().mockResolvedValue('empty')
  mocks.isRouteCurrent.mockReset().mockReturnValue(true)
  mocks.resume.mockReset()
  mocks.runtimeRevision.mockReset().mockReturnValue(undefined)
  mocks.settleSeed.mockReset()
})

describe('requested workspace surface', () => {
  it('reports host ownership rather than an unverifiable host when evidence is live', () => {
    const createSurface = vi.fn().mockReturnValue(null)

    produceRequestedWorkspaceSurface({
      identity: WORKTREE_IDENTITY,
      executionEvidence: 'live',
      owner: 'local',
      createSurface
    })

    expect(readResult(WORKTREE_IDENTITY)).toEqual({
      kind: 'unverifiable',
      reason: 'The execution host owns this workspace surface. Wait for it to publish or reconnect.'
    })
    expect(createSurface).not.toHaveBeenCalled()
  })

  it('reports an unverifiable host only when evidence is actually unverifiable', () => {
    const createSurface = vi.fn().mockReturnValue(null)

    produceRequestedWorkspaceSurface({
      identity: WORKTREE_IDENTITY,
      executionEvidence: 'unverifiable',
      owner: 'local',
      createSurface
    })

    expect(readResult(WORKTREE_IDENTITY)).toEqual({
      kind: 'unverifiable',
      reason: 'Orca cannot verify the execution host. Reconnect before retrying recovery.'
    })
    expect(createSurface).not.toHaveBeenCalled()
  })

  it('creates without host-absence confirmation when evidence is already exited', () => {
    const createSurface = vi.fn().mockReturnValue('tab-1')

    produceRequestedWorkspaceSurface({
      identity: WORKTREE_IDENTITY,
      executionEvidence: 'exited',
      owner: 'local',
      createSurface
    })

    expect(createSurface).toHaveBeenCalledWith(false)
  })

  it('passes confirmed host absence to the surface creator after an empty census', async () => {
    const createSurface = vi.fn().mockReturnValue('tab-1')

    produceRequestedWorkspaceSurface({
      identity: FOLDER_IDENTITY,
      executionEvidence: 'unverifiable',
      owner: 'local',
      createSurface
    })

    await vi.waitFor(() => expect(createSurface).toHaveBeenCalledWith(true))
    expect(mocks.resume).not.toHaveBeenCalled()
  })
})
