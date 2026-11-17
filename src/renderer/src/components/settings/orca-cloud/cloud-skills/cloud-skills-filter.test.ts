import { describe, expect, it } from 'vitest'
import type { AgentConfigSyncRow } from '../../../../../../shared/agent-config-sync/agent-config-sync-contract'
import { cloudSkillsFilterCounts, cloudSkillsFilterGroups } from './cloud-skills-filter'
import { cloudSkillsGroupRows } from './cloud-skills-sync-copy'

function row(
  kind: AgentConfigSyncRow['kind'],
  name: string,
  patch: Partial<AgentConfigSyncRow> = {}
): AgentConfigSyncRow {
  return {
    key: `user:${kind}:${name}`,
    scope: 'user',
    kind,
    name,
    bytes: 10,
    fileCount: 1,
    withheldFiles: 0,
    included: true,
    state: 'synced',
    outcome: 'added',
    ...patch
  }
}

const groups = () =>
  cloudSkillsGroupRows([
    row('claude-skill', 'deploy', { digest: 'a' }),
    row('agents-skill', 'deploy', { digest: 'a' }),
    row('claude-skill', 'scratch', {
      state: 'skipped',
      outcome: undefined,
      skipReason: 'turned-off'
    }),
    row('claude-skill', 'leaky', { state: 'skipped', outcome: undefined, skipReason: 'secret' }),
    row('claude-command', 'review')
  ])
const names = (g: ReturnType<typeof groups>): string[] =>
  [...g.synced, ...g.pending, ...g.notSynced].map((e) => e.row.name).sort()

describe('cloud skills filter', () => {
  it('Enabled is switched on, Disabled is switched off, and blocked rows show under All only', () => {
    const excluded = new Set(['user:claude-skill:scratch'])
    // deploy counts twice (Claude and Codex); leaky has no switch so it is in neither filter.
    expect(cloudSkillsFilterCounts(groups(), excluded)).toEqual({ all: 5, enabled: 3, disabled: 1 })
    expect(names(cloudSkillsFilterGroups(groups(), 'enabled', excluded, new Set()))).toEqual([
      'deploy',
      'review'
    ])
    expect(names(cloudSkillsFilterGroups(groups(), 'disabled', excluded, new Set()))).toEqual([
      'scratch'
    ])
    expect(names(cloudSkillsFilterGroups(groups(), 'all', excluded, new Set()))).toContain('leaky')
  })

  it('keeps a row toggled under a filter until the filter changes, with counts already moved', () => {
    // The user switches "review" off while Enabled is showing.
    const excluded = new Set(['user:claude-skill:scratch', 'user:claude-command:review'])
    const pinned = new Set(['user:claude-command:review'])
    expect(names(cloudSkillsFilterGroups(groups(), 'enabled', excluded, pinned))).toEqual([
      'deploy',
      'review'
    ])
    expect(cloudSkillsFilterCounts(groups(), excluded)).toEqual({ all: 5, enabled: 2, disabled: 2 })
    // A filter change starts with nothing pinned: review now shows under Disabled only.
    expect(names(cloudSkillsFilterGroups(groups(), 'enabled', excluded, new Set()))).toEqual([
      'deploy'
    ])
    expect(names(cloudSkillsFilterGroups(groups(), 'disabled', excluded, new Set()))).toEqual([
      'review',
      'scratch'
    ])
  })
})
