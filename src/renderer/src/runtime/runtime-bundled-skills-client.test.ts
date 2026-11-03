import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BUNDLED_ORCA_SKILL_RENAMES_CAPABILITY } from '../../../shared/skill-install-capability'

const mocks = vi.hoisted(() => ({ supports: vi.fn(), rpc: vi.fn() }))
vi.mock('./runtime-rpc-client', () => ({
  runtimeEnvironmentSupportsCapability: mocks.supports,
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
    await expect(executeBundledSkillsOnTarget(target, 'digest', request)).rejects.toThrow(
      'Update Orca on the server'
    )
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('plans and executes the same request on a runtime that supports migration', async () => {
    mocks.supports.mockResolvedValue(true)
    mocks.rpc
      .mockResolvedValueOnce({ planDigest: 'reviewed' })
      .mockResolvedValueOnce({ skills: [] })
    expect(await planBundledSkillsOnTarget(target, request)).toEqual({
      kind: 'plan',
      plan: { planDigest: 'reviewed' }
    })
    await executeBundledSkillsOnTarget(target, 'reviewed', request)
    expect(mocks.rpc.mock.calls[1]?.slice(0, 3)).toEqual([
      target,
      'skills.executeBundledOrca',
      { planDigest: 'reviewed', request }
    ])
  })
})
