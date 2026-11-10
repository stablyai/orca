import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BundledSkillPlan } from '../../../../../shared/bundled-skill-plan'
import type { BundledSkillTarget } from '@/lib/skills/runtime/bundled-skill-target'

const autoUpdate = vi.hoisted(() => vi.fn())
const toastWarning = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast: { warning: toastWarning } }))
vi.mock('@/store/index', () => ({
  useAppStore: { getState: () => ({ runtimeEnvironments: [] }) }
}))
vi.mock('@/runtime/skills/bundled/runtime-bundled-skills-client', () => ({
  autoUpdateBundledSkillsOnTarget: autoUpdate
}))
vi.mock('@/hooks/skills/discovery/installed-agent-skill-discovery', () => ({
  notifyInstalledAgentSkillsChanged: vi.fn()
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
})

describe('startup scan of an already-current host', () => {
  it.each<[string, BundledSkillTarget]>([
    ['this machine', { kind: 'local' }],
    ['a paired server', { kind: 'environment', environmentId: 'server-1' }]
  ])('asks %s once to record its current copy, without claiming it', async (_, target) => {
    autoUpdate.mockResolvedValue({ scope: 'global', skills: [] })

    expect(autoUpdateUnmodifiedSkills(target, currentPlan).size).toBe(0)
    await vi.waitFor(() =>
      expect(autoUpdate).toHaveBeenCalledWith(target, ['orca-cli'], expect.anything())
    )
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

  it.each<[string, (options: { onSent?: () => void }) => Promise<never>, boolean]>([
    [
      'warns when the reply to a sent marking call is lost',
      async (options) => {
        options.onSent?.()
        throw new Error('timed out')
      },
      true
    ],
    [
      'stays quiet when the marking call is refused before sending',
      async () => {
        throw new Error('server unreachable')
      },
      false
    ],
    [
      'stays quiet when the host answers the marking call with an error',
      async (options) => {
        options.onSent?.()
        throw new RuntimeRpcCallError({
          id: '1',
          ok: false,
          error: { code: 'internal', message: 'boom' },
          _meta: { runtimeId: 'r' }
        })
      },
      false
    ]
  ])('%s', async (_, reject, warns) => {
    const target: BundledSkillTarget = { kind: 'environment', environmentId: 'server-1' }
    autoUpdate.mockImplementationOnce((_target, _names, options) => reject(options))

    autoUpdateUnmodifiedSkills(target, currentPlan)
    await vi.waitFor(() => expect(getSkillUpdateRun('runtime:server-1').state).toBe('idle'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(toastWarning).toHaveBeenCalledTimes(warns ? 1 : 0)
  })
})
