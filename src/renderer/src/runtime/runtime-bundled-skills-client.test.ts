import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BUNDLED_ORCA_SKILL_CAPABILITY } from '../../../shared/skill-install-capability'

const callRuntimeRpc = vi.fn()
const runtimeEnvironmentSupportsCapability = vi.fn()

vi.mock('./runtime-rpc-client', () => ({
  callRuntimeRpc: (...args: unknown[]) => callRuntimeRpc(...args),
  runtimeEnvironmentSupportsCapability: (...args: unknown[]) =>
    runtimeEnvironmentSupportsCapability(...args)
}))

const { executeBundledSkillsOnTarget, planBundledSkillsOnTarget } =
  await import('./runtime-bundled-skills-client')

const PLAN = { scope: 'global', homeDirectory: '/home/u', skills: [], planDigest: 'd'.repeat(64) }
const SERVER = { kind: 'environment', environmentId: 'env-1' } as const
const bundledPlan = vi.fn()
const bundledExecute = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  bundledPlan.mockResolvedValue(PLAN)
  vi.stubGlobal('window', { api: { skills: { bundledPlan, bundledExecute } } })
})

describe('planBundledSkillsOnTarget', () => {
  it('plans a paired host over RPC and never this machine', async () => {
    runtimeEnvironmentSupportsCapability.mockResolvedValue(true)
    callRuntimeRpc.mockResolvedValue(PLAN)

    expect(await planBundledSkillsOnTarget(SERVER, { force: ['/x'] })).toEqual({
      kind: 'plan',
      plan: PLAN
    })
    expect(runtimeEnvironmentSupportsCapability).toHaveBeenCalledWith(
      'env-1',
      BUNDLED_ORCA_SKILL_CAPABILITY
    )
    expect(callRuntimeRpc).toHaveBeenCalledWith(
      SERVER,
      'skills.planBundledOrca',
      { force: ['/x'] },
      expect.anything()
    )
    expect(bundledPlan).not.toHaveBeenCalled()
  })

  it('reads an older server that answered its status without the capability as unsupported', async () => {
    runtimeEnvironmentSupportsCapability.mockResolvedValue(false)

    expect(await planBundledSkillsOnTarget(SERVER, {})).toEqual({
      kind: 'unsupported',
      reason: 'update-server'
    })
    expect(callRuntimeRpc).not.toHaveBeenCalled()
    expect(bundledPlan).not.toHaveBeenCalled()
  })

  it('reports a failed status probe as an error, not as an older server', async () => {
    runtimeEnvironmentSupportsCapability.mockRejectedValue(new Error('status.get timed out'))

    await expect(planBundledSkillsOnTarget(SERVER, {})).rejects.toThrow('status.get timed out')
    expect(bundledPlan).not.toHaveBeenCalled()
  })

  it('asks an SSH host no server serves to connect, and never plans this machine', async () => {
    expect(await planBundledSkillsOnTarget({ kind: 'ssh', targetId: 'box' }, {})).toEqual({
      kind: 'unsupported',
      reason: 'connect-host'
    })
    await expect(
      executeBundledSkillsOnTarget({ kind: 'ssh', targetId: 'box' }, 'd'.repeat(64), {})
    ).rejects.toThrow('skill-install-ssh-host-not-served')
    expect(bundledPlan).not.toHaveBeenCalled()
    expect(bundledExecute).not.toHaveBeenCalled()
    expect(runtimeEnvironmentSupportsCapability).not.toHaveBeenCalled()
  })

  it('plans this machine over IPC', async () => {
    expect(await planBundledSkillsOnTarget({ kind: 'local' }, {})).toEqual({
      kind: 'plan',
      plan: PLAN
    })

    expect(bundledPlan).toHaveBeenCalledWith({})
  })
})

describe('executeBundledSkillsOnTarget', () => {
  it('sends the previewed digest and request to the host that planned it', async () => {
    await executeBundledSkillsOnTarget(SERVER, 'd'.repeat(64), { force: ['/x'] })
    await executeBundledSkillsOnTarget({ kind: 'local' }, 'e'.repeat(64), {})

    expect(callRuntimeRpc).toHaveBeenCalledWith(
      SERVER,
      'skills.executeBundledOrca',
      { planDigest: 'd'.repeat(64), request: { force: ['/x'] } },
      expect.anything()
    )
    expect(bundledExecute).toHaveBeenCalledTimes(1)
    expect(bundledExecute).toHaveBeenCalledWith({
      planDigest: 'e'.repeat(64),
      request: {}
    })
  })
})
