import { describe, expect, it } from 'vitest'
import {
  exactGitConfigValuePattern,
  gitPerformanceConfigRecordPattern,
  INDEX_V4_MIN_TRACKED_ENTRIES,
  listUnconfiguredGitPerformanceConfigKeys,
  parseGitConfigRegexpOutput,
  parseGitVersion,
  planGitPerformanceConfig,
  planGitPerformanceConfigRevert,
  readGitPerformanceConfigRecord,
  summarizeGitPerformanceConfig,
  type GitPerformanceConfigSnapshot,
  type GitPerformanceHostFacts
} from './git-performance-config-plan'
import type { GitPerformanceConfigKeyPlan } from './git-performance-config-types'

function config(entries: Record<string, string[]>): Map<string, string[]> {
  return new Map(Object.entries(entries))
}

function snapshot(
  local: Record<string, string[]> = {},
  elsewhere: Record<string, string[]> = {}
): GitPerformanceConfigSnapshot {
  const effective = new Map<string, string[]>()
  for (const source of [elsewhere, local]) {
    for (const [key, values] of Object.entries(source)) {
      effective.set(key, [...(effective.get(key) ?? []), ...values])
    }
  }
  return { local: config(local), effective }
}

const macFacts: GitPerformanceHostFacts = {
  platform: 'darwin',
  gitVersion: { major: 2, minor: 50, patch: 1 },
  reliableDirectoryMtime: true,
  fsmonitorOptedIn: true,
  fsmonitor: 'compatible',
  trackedEntryCount: 18_600
}

function byKey(plan: GitPerformanceConfigKeyPlan[]): Record<string, string> {
  return Object.fromEntries(
    plan.map((entry) => [
      entry.key,
      entry.action === 'skip' ? `skip:${entry.reason}` : entry.action
    ])
  )
}

describe('parseGitVersion', () => {
  it.each([
    ['git version 2.25.5\n', { major: 2, minor: 25, patch: 5 }],
    ['git version 2.39.3 (Apple Git-146)\n', { major: 2, minor: 39, patch: 3 }],
    ['git version 2.45.1.windows.1\n', { major: 2, minor: 45, patch: 1 }],
    ['git version 2.50\n', { major: 2, minor: 50, patch: 0 }]
  ])('parses %j', (output, expected) => {
    expect(parseGitVersion(output)).toEqual(expected)
  })

  it('returns null for unrecognized output', () => {
    expect(parseGitVersion('hub version 2.14.2')).toBeNull()
  })
})

describe('parseGitConfigRegexpOutput', () => {
  it('lowercases names, keeps read order, and treats valueless keys as true', () => {
    const parsed = parseGitConfigRegexpOutput(
      'core.fsmonitor\0Orca.PerformanceConfig\ncore.untrackedCache=true\0orca.performanceconfig\ncheckout.workers=0\0'
    )
    expect(parsed.get('core.fsmonitor')).toEqual(['true'])
    expect(parsed.get('orca.performanceconfig')).toEqual([
      'core.untrackedCache=true',
      'checkout.workers=0'
    ])
  })
})

describe('planGitPerformanceConfig', () => {
  it('plans every key on a large local macOS repository with a modern Git', () => {
    expect(byKey(planGitPerformanceConfig(macFacts, snapshot()))).toEqual({
      'core.untrackedCache': 'set',
      'core.fsmonitor': 'set',
      'index.version': 'set',
      'checkout.workers': 'set',
      'fetch.writeCommitGraph': 'set'
    })
  })

  it('leaves the file watcher alone unless the user opted in separately', () => {
    const plan = (facts: Partial<GitPerformanceHostFacts>) =>
      byKey(
        planGitPerformanceConfig({ ...macFacts, fsmonitorOptedIn: false, ...facts }, snapshot())
      )
    expect(plan({})['core.fsmonitor']).toBe('skip:not-opted-in')
    // The opt-in is reported before version or platform, which would only add noise.
    expect(plan({ gitVersion: { major: 2, minor: 30, patch: 0 } })['core.fsmonitor']).toBe(
      'skip:not-opted-in'
    )
    expect(plan({})['checkout.workers']).toBe('set')
  })

  it('applies the version floors of each key', () => {
    const plan = (minor: number) =>
      byKey(
        planGitPerformanceConfig(
          { ...macFacts, gitVersion: { major: 2, minor, patch: 0 } },
          snapshot()
        )
      )
    expect(plan(24)['fetch.writeCommitGraph']).toBe('skip:git-too-old')
    expect(plan(25)['checkout.workers']).toBe('skip:git-too-old')
    expect(plan(31)['checkout.workers']).toBe('skip:git-too-old')
    expect(plan(32)['checkout.workers']).toBe('set')
    // 2.36 has the daemon but not the network-mount refusal.
    expect(plan(36)['core.fsmonitor']).toBe('skip:git-too-old')
    expect(plan(37)['core.fsmonitor']).toBe('set')
  })

  it('skips everything when the Git version cannot be read', () => {
    const plan = planGitPerformanceConfig({ ...macFacts, gitVersion: null }, snapshot())
    expect(plan.every((entry) => entry.action === 'skip')).toBe(true)
  })

  it('never enables fsmonitor on Linux and never enables the untracked cache on Windows', () => {
    expect(byKey(planGitPerformanceConfig({ ...macFacts, platform: 'linux' }, snapshot()))).toEqual(
      expect.objectContaining({
        'core.fsmonitor': 'skip:platform',
        'core.untrackedCache': 'set'
      })
    )
    expect(byKey(planGitPerformanceConfig({ ...macFacts, platform: 'win32' }, snapshot()))).toEqual(
      expect.objectContaining({ 'core.fsmonitor': 'set', 'core.untrackedCache': 'skip:platform' })
    )
  })

  it('skips filesystem-dependent keys on network or unknown filesystems', () => {
    const plan = byKey(
      planGitPerformanceConfig(
        { ...macFacts, reliableDirectoryMtime: false, fsmonitor: 'incompatible' },
        snapshot()
      )
    )
    expect(plan['core.untrackedCache']).toBe('skip:filesystem')
    expect(plan['core.fsmonitor']).toBe('skip:fsmonitor-incompatible')
    expect(plan['checkout.workers']).toBe('set')
  })

  it('uses index v4 only above the tracked-file threshold', () => {
    const plan = (count: number | null) =>
      byKey(planGitPerformanceConfig({ ...macFacts, trackedEntryCount: count }, snapshot()))[
        'index.version'
      ]
    expect(plan(INDEX_V4_MIN_TRACKED_ENTRIES - 1)).toBe('skip:small-repository')
    expect(plan(INDEX_V4_MIN_TRACKED_ENTRIES)).toBe('set')
    expect(plan(null)).toBe('skip:small-repository')
  })

  it('never overrides a value set in any scope, including false', () => {
    const plan = byKey(
      planGitPerformanceConfig(
        macFacts,
        snapshot({ 'checkout.workers': ['4'] }, { 'core.fsmonitor': ['false'] })
      )
    )
    expect(plan['checkout.workers']).toBe('skip:set-by-user')
    expect(plan['core.fsmonitor']).toBe('skip:set-by-user')
  })

  it('treats an explicit feature.manyFiles or legacy builtin fsmonitor as the user choosing', () => {
    const plan = byKey(
      planGitPerformanceConfig(
        macFacts,
        snapshot({}, { 'feature.manyfiles': ['false'], 'core.usebuiltinfsmonitor': ['true'] })
      )
    )
    expect(plan['core.untrackedCache']).toBe('skip:set-by-feature-many-files')
    expect(plan['index.version']).toBe('skip:set-by-feature-many-files')
    expect(plan['core.fsmonitor']).toBe('skip:set-by-user')
  })

  it('keeps keys Orca already wrote instead of reporting them as the user’s', () => {
    const applied = snapshot({
      'checkout.workers': ['0'],
      'orca.performanceconfig': ['checkout.workers=0']
    })
    expect(byKey(planGitPerformanceConfig(macFacts, applied))['checkout.workers']).toBe('keep')
    expect(listUnconfiguredGitPerformanceConfigKeys(applied)).not.toContain('checkout.workers')
  })
})

describe('Orca record and revert', () => {
  it('reverts only keys whose local value is still exactly what Orca recorded', () => {
    const state = snapshot(
      {
        'checkout.workers': ['0'],
        'fetch.writecommitgraph': ['false'],
        'orca.performanceconfig': [
          'checkout.workers=0',
          'fetch.writeCommitGraph=true',
          'core.untrackedCache=true',
          'unknown.key=1'
        ]
      },
      { 'core.untrackedcache': ['true'] }
    )
    expect(readGitPerformanceConfigRecord(state.local).map((entry) => entry.key)).toEqual([
      'checkout.workers',
      'fetch.writeCommitGraph',
      'core.untrackedCache'
    ])
    // The user changed fetch.writeCommitGraph, and core.untrackedCache lives in another scope.
    expect(planGitPerformanceConfigRevert(state)).toEqual([{ key: 'checkout.workers', value: '0' }])
    expect(summarizeGitPerformanceConfig(state)).toEqual({
      orcaKeys: [{ key: 'checkout.workers', value: '0' }],
      userKeys: ['core.untrackedCache', 'fetch.writeCommitGraph']
    })
  })

  it('reports a key as also user-set when another scope defines it on top of Orca’s value', () => {
    const state = snapshot(
      { 'checkout.workers': ['0'], 'orca.performanceconfig': ['checkout.workers=0'] },
      { 'checkout.workers': ['8'] }
    )
    expect(summarizeGitPerformanceConfig(state)).toEqual({
      orcaKeys: [{ key: 'checkout.workers', value: '0' }],
      userKeys: ['checkout.workers']
    })
  })

  it('limits a partial revert to the requested keys', () => {
    const state = snapshot({
      'checkout.workers': ['0'],
      'core.fsmonitor': ['true'],
      'orca.performanceconfig': ['checkout.workers=0', 'core.fsmonitor=true']
    })
    expect(planGitPerformanceConfigRevert(state, ['core.fsmonitor'])).toEqual([
      { key: 'core.fsmonitor', value: 'true' }
    ])
  })

  it('builds exact value patterns for conditional unset', () => {
    expect(exactGitConfigValuePattern('true')).toBe('^true$')
    expect(exactGitConfigValuePattern('a.b+c')).toBe('^a\\.b\\+c$')
    expect(gitPerformanceConfigRecordPattern('core.fsmonitor')).toBe('^core\\.fsmonitor=')
  })
})
