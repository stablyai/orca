import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SkillDiscoveryResult, SkillDiscoveryTarget } from '../../../shared/skills'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from './runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from './runtime-rpc-client'
import { discoverSkillsForRuntimeTarget } from './runtime-skills-client'

function discoveryResult(skillName: string): SkillDiscoveryResult {
  return {
    skills: [
      {
        id: 'skill-1',
        name: skillName,
        description: null,
        providers: ['agent-skills'],
        sourceKind: 'home',
        sourceLabel: 'Agent skills home',
        rootPath: '/home/dev/.agents/skills',
        directoryPath: `/home/dev/.agents/skills/${skillName}`,
        skillFilePath: `/home/dev/.agents/skills/${skillName}/SKILL.md`,
        installed: true,
        fileCount: 1,
        updatedAt: null
      }
    ],
    sources: [],
    scannedAt: 0
  }
}

const discover = vi.fn<(target?: SkillDiscoveryTarget) => Promise<SkillDiscoveryResult>>()
const runtimeEnvironmentCall = vi.fn()

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  discover.mockReset()
  runtimeEnvironmentCall.mockReset()
  vi.stubGlobal('window', {
    api: {
      skills: { discover },
      runtimeEnvironments: {
        call: (args: RuntimeEnvironmentCallRequest) =>
          createCompatibleRuntimeStatusResponseIfNeeded(args) ?? runtimeEnvironmentCall(args)
      }
    }
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('discoverSkillsForRuntimeTarget', () => {
  it('scans the local host through the skills IPC for a local target', async () => {
    const result = discoveryResult('orchestration')
    discover.mockResolvedValueOnce(result)
    const target: SkillDiscoveryTarget = { runtime: 'host' }

    await expect(discoverSkillsForRuntimeTarget({ kind: 'local' }, target)).resolves.toBe(result)

    expect(discover).toHaveBeenCalledWith(target)
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
  })

  it('routes to the remote runtime and drops the local-only target', async () => {
    const result = discoveryResult('orchestration')
    runtimeEnvironmentCall.mockResolvedValueOnce({ id: 'skills', ok: true, result })

    await expect(
      discoverSkillsForRuntimeTarget(
        { kind: 'environment', environmentId: 'env-1' },
        { runtime: 'wsl', wslDistro: 'Ubuntu' }
      )
    ).resolves.toBe(result)

    expect(discover).not.toHaveBeenCalled()
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
      expect.objectContaining({ selector: 'env-1', method: 'skills.discover', params: {} })
    )
  })

  it('forwards an explicit cwd to the remote runtime', async () => {
    const result = discoveryResult('orchestration')
    runtimeEnvironmentCall.mockResolvedValueOnce({ id: 'skills', ok: true, result })

    await discoverSkillsForRuntimeTarget(
      { kind: 'environment', environmentId: 'env-1' },
      { cwd: '/workspace/app' }
    )

    expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'skills.discover', params: { cwd: '/workspace/app' } })
    )
  })

  // Why: the server resolves its own project runtime from worktree identity, so
  // dropping this would scan the wrong roots for a WSL-configured remote project.
  it('forwards worktree identity so the remote resolves its own project runtime', async () => {
    runtimeEnvironmentCall.mockResolvedValueOnce({
      id: 'skills',
      ok: true,
      result: discoveryResult('orchestration')
    })

    await discoverSkillsForRuntimeTarget(
      { kind: 'environment', environmentId: 'env-1' },
      { worktreeId: 'wt-1', runtime: 'wsl', wslDistro: 'Ubuntu' }
    )

    expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'skills.discover', params: { worktreeId: 'wt-1' } })
    )
  })
})
