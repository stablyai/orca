import { describe, expect, it } from 'vitest'
import type { AgentConfigSyncRow } from '../../../../../../shared/agent-config-sync/agent-config-sync-contract'
import {
  cloudSkillsEntryCount,
  cloudSkillsEntryKeys,
  cloudSkillsEntryKindLabel,
  cloudSkillsGroupRows
} from './cloud-skills-sync-copy'

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

describe('cloudSkillsGroupRows', () => {
  it('shows one skill installed for both agents as one row with both labels and both keys', () => {
    const groups = cloudSkillsGroupRows([
      row('agents-skill', 'lint', { digest: 'a', outcome: 'unchanged' }),
      row('claude-skill', 'lint', { digest: 'a' })
    ])
    expect(groups.synced).toHaveLength(1)
    const [entry] = groups.synced
    expect(cloudSkillsEntryKindLabel(entry)).toBe('Claude skill, Codex skill')
    expect(cloudSkillsEntryKeys(entry).sort()).toEqual([
      'user:agents-skill:lint',
      'user:claude-skill:lint'
    ])
    expect(cloudSkillsEntryCount(groups.synced)).toBe(2)
  })

  it('keeps two different skills that share a name on their own rows', () => {
    const groups = cloudSkillsGroupRows([
      row('agents-skill', 'lint', { digest: 'a' }),
      row('claude-skill', 'lint', { digest: 'b' })
    ])
    expect(groups.synced).toHaveLength(2)
    expect(groups.synced.every((entry) => entry.twins.length === 0)).toBe(true)
  })

  it('does not merge a synced copy with a skipped one', () => {
    const groups = cloudSkillsGroupRows([
      row('agents-skill', 'lint', { digest: 'a' }),
      row('claude-skill', 'lint', { digest: 'a', state: 'skipped', outcome: 'kept-host' })
    ])
    expect(groups.synced).toHaveLength(1)
    expect(groups.notSynced).toHaveLength(1)
  })
})
