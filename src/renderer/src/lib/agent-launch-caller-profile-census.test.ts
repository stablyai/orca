// Ties every caller profile back to the call site it characterizes. The behaviour files feed the
// profiles through the real funnel; without this census a call site could change what it passes and
// the behaviour files would keep happily pinning a shape nobody sends any more.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { glob } from 'tinyglobby'
import { AGENT_LAUNCH_CALLER_PROFILES } from './agent-launch-caller-profiles-test-harness'

const REPO_ROOT = join(import.meta.dirname, '../../../..')
const FUNNEL = 'src/renderer/src/lib/launch-agent-in-new-tab.ts'

async function productionCallers(): Promise<string[]> {
  const files = await glob(['src/**/*.ts', 'src/**/*.tsx'], {
    cwd: REPO_ROOT,
    ignore: ['**/*.test.ts', '**/*.test.tsx']
  })
  return files
    .filter((file) => file !== FUNNEL)
    .filter((file) => readFileSync(join(REPO_ROOT, file), 'utf8').includes('launchAgentInNewTab('))
    .sort()
}

describe('agent launch caller profiles', () => {
  it('covers every production call site of the funnel and no phantom one', async () => {
    const profiled = AGENT_LAUNCH_CALLER_PROFILES.map((profile) => profile.caller).sort()

    expect(profiled).toEqual(await productionCallers())
  })

  it('names each profile exactly once', () => {
    const ids = AGENT_LAUNCH_CALLER_PROFILES.map((profile) => profile.id)

    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.length).toBe(13)
  })

  it.each(AGENT_LAUNCH_CALLER_PROFILES.map((profile) => [profile.id, profile] as const))(
    'keeps %s anchored to the arguments its call site still builds',
    (_id, profile) => {
      const source = readFileSync(join(REPO_ROOT, profile.caller), 'utf8')

      // Why: a positive control on the instrument — an unreadable or renamed file would otherwise
      // make every marker below vacuously "not found" and the assertion would just be noise.
      expect(source).toContain('launchAgentInNewTab(')
      expect(profile.sourceMarkers.length).toBeGreaterThan(0)
      for (const marker of profile.sourceMarkers) {
        expect(source).toContain(marker)
      }
    }
  )

  it.each(AGENT_LAUNCH_CALLER_PROFILES.map((profile) => [profile.id, profile] as const))(
    'records whether %s installs launch callbacks, matching its source',
    (_id, profile) => {
      const source = readFileSync(join(REPO_ROOT, profile.caller), 'utf8')

      expect(source.includes('beforeSurfaceOpen:')).toBe(profile.passesBeforeSurfaceOpen)
      expect(source.includes('agentSessionLaunchPlan,')).toBe(profile.passesLaunchPlan)
      expect(source.includes('onPromptDelivered')).toBe(profile.passesOnPromptDelivered)
    }
  )

  it('pins which call sites read a tab id straight off the synchronous result', () => {
    const readers = AGENT_LAUNCH_CALLER_PROFILES.filter((profile) =>
      profile.readsBack.includes('surface-tab-id')
    ).map((profile) => profile.id)

    // Why: this is the coupling a move to an async launch RPC threatens most directly — these
    // call sites cannot tolerate a tab id that only exists after the launch settles.
    expect(readers.sort()).toEqual([
      'fix-checks',
      'floating-default-agent',
      'quick-command',
      'source-control-action',
      'source-control-recovery',
      'tab-bar-create-menu',
      'tab-bar-quick-launch-button'
    ])
  })

  it('pins which call sites await the prompt-delivery promise', () => {
    const awaiters = AGENT_LAUNCH_CALLER_PROFILES.filter((profile) =>
      profile.readsBack.includes('prompt-delivery-result')
    ).map((profile) => profile.id)

    expect(awaiters.sort()).toEqual(['session-continuation', 'source-control-action'])
  })
})
