import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BUNDLED_ORCA_SKILL_RENAMES_CAPABILITY } from '../../../../../shared/skill-install-capability'

const mocks = vi.hoisted(() => ({ supports: vi.fn(), rpc: vi.fn() }))
vi.mock('../../rpc/compatibility/runtime-capability-proof', () => ({
  runtimeEnvironmentSupportsCapability: mocks.supports
}))
vi.mock('../../rpc/calls/runtime-rpc-call', () => ({
  callRuntimeRpc: mocks.rpc
}))
import {
  autoUpdateBundledSkillsOnTarget,
  executeBundledSkillsOnTarget,
  planBundledSkillsOnTarget
} from './runtime-bundled-skills-client'

const target = { kind: 'environment', environmentId: 'paired-server' } as const
const request = { names: ['orca-computer-use'] }

beforeEach(() => {
  vi.clearAllMocks()
})

describe('renamed skills on paired runtimes', () => {
  it('offers a server update before sending an unsupported canonical name', async () => {
    mocks.supports.mockImplementation(
      async (_id, capability) => capability !== BUNDLED_ORCA_SKILL_RENAMES_CAPABILITY
    )
    expect(await planBundledSkillsOnTarget(target, request)).toEqual({
      kind: 'unsupported',
      reason: 'update-server'
    })
    expect(await autoUpdateBundledSkillsOnTarget(target, request.names)).toBeNull()
    const outcome = await executeBundledSkillsOnTarget(target, 'digest', request).then(
      () => 'fulfilled',
      () => 'rejected'
    )
    expect(outcome).toBe('rejected')
    expect(mocks.rpc).not.toHaveBeenCalled()
  })
})
