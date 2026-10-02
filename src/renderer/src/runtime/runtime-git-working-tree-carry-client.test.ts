import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  GIT_CARRY_WORKING_TREE_CHANGES_RUNTIME_CAPABILITY,
  RUNTIME_CAPABILITIES
} from '../../../shared/protocol-version'

const callRuntimeRpc = vi.fn()
const runtimeEnvironmentSupportsCapability = vi.fn()
const getActiveRuntimeTarget = vi.fn()
vi.mock('./runtime-rpc-client', () => ({
  callRuntimeRpc,
  runtimeEnvironmentSupportsCapability,
  getActiveRuntimeTarget
}))
const ensureLocalRuntimeCapabilities = vi.fn()
vi.mock('./local-runtime-capabilities', () => ({ ensureLocalRuntimeCapabilities }))
vi.mock('./runtime-worktree-selector', () => ({
  toRuntimeWorktreeSelector: (id: string) => `id:${id}`
}))

const { carryRuntimeWorkingTreeChanges, isWorkingTreeCarrySupported } =
  await import('./runtime-git-working-tree-carry-client')

const context = {
  settings: null,
  connectionId: 'ssh-1',
  source: { worktreeId: 'repo::a', worktreePath: '/r/a' },
  target: { worktreeId: 'repo::b', worktreePath: '/r/b' }
}

const localCarry = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  localCarry.mockResolvedValue({ ok: true, trackedChanges: false, untrackedCopied: 0 })
  vi.stubGlobal('window', { api: { git: { carryWorkingTreeChanges: localCarry } } })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('carryRuntimeWorkingTreeChanges', () => {
  it('uses local ipc (which routes ssh) when the runtime target is local', async () => {
    getActiveRuntimeTarget.mockReturnValue({ kind: 'local' })
    await expect(carryRuntimeWorkingTreeChanges(context)).resolves.toEqual({
      ok: true,
      trackedChanges: false,
      untrackedCopied: 0
    })
    expect(localCarry).toHaveBeenCalledWith({
      sourceWorktreePath: '/r/a',
      targetWorktreePath: '/r/b',
      connectionId: 'ssh-1'
    })
    expect(callRuntimeRpc).not.toHaveBeenCalled()
  })

  it('uses runtime rpc with worktree selectors for a remote environment', async () => {
    getActiveRuntimeTarget.mockReturnValue({ kind: 'environment', environmentId: 'env-1' })
    callRuntimeRpc.mockResolvedValue({ ok: false, reason: 'too_large' })
    await expect(carryRuntimeWorkingTreeChanges(context)).resolves.toEqual({
      ok: false,
      reason: 'too_large'
    })
    expect(callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-1' },
      'git.carryWorkingTreeChanges',
      { sourceWorktree: 'id:repo::a', targetWorktree: 'id:repo::b' },
      { timeoutMs: 120_000 }
    )
    expect(localCarry).not.toHaveBeenCalled()
  })

  it('reads an unrecognised host reply as a failed carry', async () => {
    getActiveRuntimeTarget.mockReturnValue({ kind: 'environment', environmentId: 'env-1' })
    callRuntimeRpc.mockResolvedValue({ ok: 'maybe' })
    await expect(carryRuntimeWorkingTreeChanges(context)).resolves.toMatchObject({
      ok: false,
      reason: 'apply_failed'
    })
  })
})

describe('isWorkingTreeCarrySupported', () => {
  it('is supported when the local runtime advertises the capability', async () => {
    getActiveRuntimeTarget.mockReturnValue({ kind: 'local' })
    ensureLocalRuntimeCapabilities.mockResolvedValue(['git.carry-working-tree-changes.v1'])
    await expect(isWorkingTreeCarrySupported(null)).resolves.toBe(true)
    expect(runtimeEnvironmentSupportsCapability).not.toHaveBeenCalled()
  })

  it('is unsupported when the web client is paired to a host that predates it', async () => {
    getActiveRuntimeTarget.mockReturnValue({ kind: 'local' })
    ensureLocalRuntimeCapabilities.mockResolvedValue(['runtime.status.compat.v1'])
    await expect(isWorkingTreeCarrySupported(null)).resolves.toBe(false)
  })

  it('stays offered when the local runtime has not answered yet', async () => {
    getActiveRuntimeTarget.mockReturnValue({ kind: 'local' })
    ensureLocalRuntimeCapabilities.mockResolvedValue(null)
    await expect(isWorkingTreeCarrySupported(null)).resolves.toBe(true)
  })

  it('asks remote environments for the capability', async () => {
    getActiveRuntimeTarget.mockReturnValue({ kind: 'environment', environmentId: 'env-1' })
    runtimeEnvironmentSupportsCapability.mockResolvedValue(false)
    await expect(isWorkingTreeCarrySupported(null)).resolves.toBe(false)
    expect(runtimeEnvironmentSupportsCapability).toHaveBeenCalledWith(
      'env-1',
      'git.carry-working-tree-changes.v1',
      10_000
    )
  })

  it('is advertised by this build of the runtime', () => {
    expect(GIT_CARRY_WORKING_TREE_CHANGES_RUNTIME_CAPABILITY).toBe(
      'git.carry-working-tree-changes.v1'
    )
    expect(RUNTIME_CAPABILITIES).toContain(GIT_CARRY_WORKING_TREE_CHANGES_RUNTIME_CAPABILITY)
  })
})
