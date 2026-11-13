import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BundledSkillPlan } from '../../../../../shared/bundled-skill-plan'
import type { BundledSkillTarget } from '@/lib/skills/runtime/bundled-skill-target'

const autoUpdate = vi.hoisted(() => vi.fn())
const toastWarning = vi.hoisted(() => vi.fn())
const skillsChanged = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast: { warning: toastWarning } }))
vi.mock('@/store/index', () => ({
  useAppStore: { getState: () => ({ runtimeEnvironments: [] }) }
}))
vi.mock('@/runtime/skills/bundled/runtime-bundled-skills-client', () => ({
  autoUpdateBundledSkillsOnTarget: autoUpdate
}))
vi.mock('@/hooks/skills/discovery/installed-agent-skill-discovery', () => ({
  notifyInstalledAgentSkillsChanged: skillsChanged
}))

const { _resetSkillFreshnessAutoUpdate, autoUpdateUnmodifiedSkills } =
  await import('./skill-freshness-auto-update')
const { getSkillUpdateRun } = await import('./skill-update-run-store')
const { RuntimeRpcCallError } = await import('@/runtime/rpc/calls/runtime-rpc-result')

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
  toastWarning.mockReset()
  skillsChanged.mockReset()
})

describe('startup scan of an already-current host', () => {
  it.each<[string, BundledSkillTarget]>([
    ['this machine', { kind: 'local' }],
    ['a paired server', { kind: 'environment', environmentId: 'server-1' }]
  ])('asks %s once to record its current copy, without claiming it', async (_, target) => {
    autoUpdate.mockResolvedValue({ scope: 'global', skills: [] })

    expect(autoUpdateUnmodifiedSkills(target, currentPlan).size).toBe(0)
    await vi.waitFor(() =>
      expect(autoUpdate).toHaveBeenCalledWith(target, ['orca-cli'], { recordOnly: true })
    )
    autoUpdateUnmodifiedSkills(target, currentPlan)
    expect(autoUpdate).toHaveBeenCalledTimes(1)
  })

  it.each<[string, () => Promise<unknown>]>([
    ['the record-only call keeps failing', () => Promise.reject(new Error('offline'))],
    [
      'a sent record-only call times out',
      () =>
        Promise.reject(
          new RuntimeRpcCallError({
            id: '1',
            ok: false,
            error: { code: 'timeout', message: 'Timed out waiting for the remote Orca runtime' },
            _meta: { runtimeId: 'r' }
          })
        )
    ],
    [
      'the host keeps reporting the skill busy',
      () =>
        Promise.resolve({
          scope: 'global',
          skills: [{ name: 'orca-cli', status: 'busy', ops: [] }]
        })
    ]
  ])('asks only once per session, without a warning or re-plan, when %s', async (_, reply) => {
    const target: BundledSkillTarget = { kind: 'environment', environmentId: 'server-1' }
    autoUpdate.mockImplementation(reply)
    // The nudge re-plans on every skills-changed signal and scans the fresh plan, as in the app.
    // Capped so a regression fails instead of spinning forever.
    let refreshes = 0
    skillsChanged.mockImplementation(() => {
      refreshes += 1
      if (refreshes < 5) {
        autoUpdateUnmodifiedSkills(target, currentPlan)
      }
    })

    autoUpdateUnmodifiedSkills(target, currentPlan)
    // The run is marked running synchronously, so this first passes after the call has settled.
    await vi.waitFor(() => expect(getSkillUpdateRun('runtime:server-1').state).toBe('idle'))
    autoUpdateUnmodifiedSkills(target, currentPlan)

    expect(autoUpdate).toHaveBeenCalledTimes(1)
    expect(refreshes).toBe(0)
    // A record-only call can never write a skill, so no failure of it is worth a warning.
    expect(toastWarning).not.toHaveBeenCalled()
  })
})

describe('silent update of a released copy', () => {
  const RELEASED = 'b'.repeat(64)
  const releasedPlan: BundledSkillPlan = {
    ...currentPlan,
    skills: [
      {
        name: 'orca-cli',
        digest: DIGEST,
        ops: [
          {
            kind: 'update',
            path: '/home/me/.agents/skills/orca-cli',
            role: 'shared',
            agents: [],
            observed: { kind: 'folder', entries: ['SKILL.md:file'], skillDigest: RELEASED },
            cleanup: []
          }
        ]
      },
      {
        name: 'orchestration',
        digest: DIGEST,
        ops: [
          {
            kind: 'keep',
            path: '/home/me/.agents/skills/orchestration',
            role: 'shared',
            agents: [],
            observed: { kind: 'folder', entries: ['SKILL.md:file'], skillDigest: DIGEST },
            cleanup: []
          }
        ]
      }
    ]
  }

  it('updates without a record-only request in the same scan, and warns when the reply is lost', async () => {
    const target: BundledSkillTarget = { kind: 'environment', environmentId: 'server-1' }
    autoUpdate.mockRejectedValueOnce(new Error('timed out'))
    autoUpdate.mockResolvedValue({ scope: 'global', skills: [] })

    expect([...autoUpdateUnmodifiedSkills(target, releasedPlan)]).toEqual(['orca-cli'])
    expect(autoUpdate).toHaveBeenCalledWith(target, ['orca-cli'], { recordOnly: false })
    await vi.waitFor(() => expect(toastWarning).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(skillsChanged).toHaveBeenCalledTimes(1))

    // The re-plan after the update records the current copy on its own.
    autoUpdateUnmodifiedSkills(target, releasedPlan)
    expect(autoUpdate).toHaveBeenLastCalledWith(target, ['orchestration'], { recordOnly: true })
  })
})
