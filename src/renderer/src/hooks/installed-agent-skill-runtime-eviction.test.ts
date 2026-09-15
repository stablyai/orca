import { afterEach, expect, it, vi } from 'vitest'
import type { SkillDiscoveryResult } from '../../../shared/skills'

const discover = vi.hoisted(() => vi.fn<() => Promise<SkillDiscoveryResult>>())

vi.mock('@/runtime/runtime-skills-client', () => ({ discoverSkillsForRuntimeTarget: discover }))

import {
  discoverInstalledAgentSkills,
  evictInstalledAgentSkillDiscoveryForRuntimeEnvironments,
  getCachedSkillDiscovery,
  getRuntimeScopedSkillDiscoveryKey,
  resetSkillDiscoveryCacheForTests
} from './installed-agent-skill-discovery'

const result = (scannedAt: number): SkillDiscoveryResult => ({ skills: [], sources: [], scannedAt })

const runtime = (environmentId: string) => ({ kind: 'environment' as const, environmentId })

afterEach(() => {
  resetSkillDiscoveryCacheForTests()
  discover.mockReset()
})

it.each(['env', 'env"[,]'])(
  'evicts every filtered scan for %s without evicting other owners',
  async (id) => {
    const owner = runtime(id)
    const other = runtime(`${id}-other`)
    discover.mockResolvedValue(result(1))

    for (const names of [['alpha'], ['beta'], undefined]) {
      await discoverInstalledAgentSkills(false, undefined, owner, names, ['home'])
    }

    await discoverInstalledAgentSkills(false, undefined, other, ['alpha'], ['home'])
    await discoverInstalledAgentSkills(false, undefined, { kind: 'local' }, ['alpha'], ['home'])

    evictInstalledAgentSkillDiscoveryForRuntimeEnvironments([id])
    discover.mockResolvedValue(result(2))

    for (const names of [['alpha'], ['beta'], undefined]) {
      const key = getRuntimeScopedSkillDiscoveryKey(owner, undefined, names, ['home'])
      expect(getCachedSkillDiscovery(key)).toBeNull()
      await expect(
        discoverInstalledAgentSkills(false, undefined, owner, names, ['home'])
      ).resolves.toEqual(result(2))
    }

    await expect(
      discoverInstalledAgentSkills(false, undefined, other, ['alpha'], ['home'])
    ).resolves.toEqual(result(1))
    await expect(
      discoverInstalledAgentSkills(false, undefined, { kind: 'local' }, ['alpha'], ['home'])
    ).resolves.toEqual(result(1))
    expect(discover).toHaveBeenCalledTimes(8)
  }
)

it('keeps a retired filtered response from replacing the new peer cache', async () => {
  let finishOld!: (value: SkillDiscoveryResult) => void
  discover.mockReturnValueOnce(
    new Promise((resolve) => {
      finishOld = resolve
    })
  )
  const owner = runtime('env')
  const old = discoverInstalledAgentSkills(false, undefined, owner, ['alpha'], ['home'])
  evictInstalledAgentSkillDiscoveryForRuntimeEnvironments(['env'])
  discover.mockResolvedValue(result(2))
  await expect(
    discoverInstalledAgentSkills(false, undefined, owner, ['alpha'], ['home'])
  ).resolves.toEqual(result(2))
  finishOld(result(1))
  await old
  await expect(
    discoverInstalledAgentSkills(false, undefined, owner, ['alpha'], ['home'])
  ).resolves.toEqual(result(2))
  expect(discover).toHaveBeenCalledTimes(2)
})
