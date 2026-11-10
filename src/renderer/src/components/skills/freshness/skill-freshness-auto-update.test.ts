import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BundledSkillPlan } from '../../../../../shared/bundled-skill-plan'
import type { BundledSkillTarget } from '@/lib/skills/runtime/bundled-skill-target'

const autoUpdate = vi.hoisted(() => vi.fn())
vi.mock('@/runtime/skills/bundled/runtime-bundled-skills-client', () => ({
  autoUpdateBundledSkillsOnTarget: autoUpdate
}))
vi.mock('@/hooks/skills/discovery/installed-agent-skill-discovery', () => ({
  notifyInstalledAgentSkillsChanged: vi.fn()
}))

const { _resetSkillFreshnessAutoUpdate, autoUpdateUnmodifiedSkills } =
  await import('./skill-freshness-auto-update')
const { getSkillUpdateRun } = await import('./skill-update-run-store')

const DIGEST = 'a'.repeat(64)

/** Every location already holds this build's bytes: the plan is keep-only. */
const currentPlan: BundledSkillPlan = {
  scope: 'global',
  homeDirectory: '/home/me',
  planDigest: 'p'.repeat(64),
  skills: [
    {
      name: 'orca-cli',
      digest: DIGEST,
      ops: [
        {
          kind: 'keep',
          path: '/home/me/.agents/skills/orca-cli',
          role: 'shared',
          agents: [],
          observed: { kind: 'folder', entries: ['SKILL.md:file'], skillDigest: DIGEST },
          cleanup: []
        }
      ]
    }
  ]
}

afterEach(() => {
  _resetSkillFreshnessAutoUpdate()
  autoUpdate.mockReset()
})

describe('startup scan of an already-current host', () => {
  it.each<[string, BundledSkillTarget]>([
    ['this machine', { kind: 'local' }],
    ['a paired server', { kind: 'environment', environmentId: 'server-1' }]
  ])('asks %s once to record its current copy, without claiming it', async (_, target) => {
    autoUpdate.mockResolvedValue({ scope: 'global', skills: [] })

    expect(autoUpdateUnmodifiedSkills(target, currentPlan).size).toBe(0)
    await vi.waitFor(() => expect(autoUpdate).toHaveBeenCalledWith(target, ['orca-cli']))
    autoUpdateUnmodifiedSkills(target, currentPlan)
    expect(autoUpdate).toHaveBeenCalledTimes(1)
  })

  it('asks again on the next scan when the marking call fails, and not after it succeeds', async () => {
    const target: BundledSkillTarget = { kind: 'local' }
    autoUpdate.mockRejectedValueOnce(new Error('offline'))
    autoUpdate.mockResolvedValue({ scope: 'global', skills: [] })

    autoUpdateUnmodifiedSkills(target, currentPlan)
    await vi.waitFor(() => expect(autoUpdate).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => {
      autoUpdateUnmodifiedSkills(target, currentPlan)
      expect(autoUpdate).toHaveBeenCalledTimes(2)
    })
    await vi.waitFor(() => expect(getSkillUpdateRun('local').state).toBe('idle'))
    autoUpdateUnmodifiedSkills(target, currentPlan)
    expect(autoUpdate).toHaveBeenCalledTimes(2)
  })

  it('asks again when the host reports the skill busy', async () => {
    const target: BundledSkillTarget = { kind: 'local' }
    autoUpdate.mockResolvedValueOnce({
      scope: 'global',
      skills: [{ name: 'orca-cli', status: 'busy', ops: [] }]
    })
    autoUpdate.mockResolvedValue({ scope: 'global', skills: [] })

    autoUpdateUnmodifiedSkills(target, currentPlan)
    await vi.waitFor(() => {
      autoUpdateUnmodifiedSkills(target, currentPlan)
      expect(autoUpdate).toHaveBeenCalledTimes(2)
    })
  })
})
