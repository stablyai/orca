// The memoized by-id index behind the per-row render lookups: parity with the
// linear scans it replaced (first duplicate wins, null rows skipped, invalid
// bases never resolve) and O(1) reuse of one index per published array.
import { describe, expect, it } from 'vitest'
import type { CustomTuiAgent, DeletedCustomTuiAgent } from '../../../shared/types'
import { customAgentSettingsBase, customAgentSettingsLabel } from './custom-agent-settings-index'

const liveId = 'custom-agent:claude:11111111-1111-4111-8111-111111111111' as CustomTuiAgent['id']
const deletedId = 'custom-agent:codex:22222222-2222-4222-8222-222222222222' as CustomTuiAgent['id']

const live: CustomTuiAgent = {
  id: liveId,
  baseAgent: 'claude',
  label: 'Reviewer',
  args: '',
  env: {},
  syncEnv: false
}

const tombstone: DeletedCustomTuiAgent = {
  id: deletedId,
  baseAgent: 'codex',
  label: 'Retired',
  deletedAt: 1
}

describe('customAgentSettingsLabel / customAgentSettingsBase', () => {
  it('resolves a live definition first, then the tombstone, else null', () => {
    const settings = { customTuiAgents: [live], deletedCustomTuiAgents: [tombstone] }
    expect(customAgentSettingsLabel(settings, liveId)).toBe('Reviewer')
    expect(customAgentSettingsLabel(settings, deletedId)).toBe('Retired')
    expect(customAgentSettingsBase(settings, liveId)).toBe('claude')
    expect(customAgentSettingsBase(settings, deletedId)).toBe('codex')
    expect(
      customAgentSettingsLabel(settings, 'custom-agent:claude:unknown' as CustomTuiAgent['id'])
    ).toBeNull()
    expect(customAgentSettingsLabel(null, liveId)).toBeNull()
    expect(customAgentSettingsBase(undefined, liveId)).toBeNull()
  })

  it('matches the scans it replaced: first duplicate wins and null rows are skipped', () => {
    const settings = {
      customTuiAgents: [null as unknown as CustomTuiAgent, live, { ...live, label: 'Shadowed' }]
    }
    expect(customAgentSettingsLabel(settings, liveId)).toBe('Reviewer')
  })

  it('never resolves a base outside the built-in set, falling through to the tombstone', () => {
    const settings = {
      customTuiAgents: [{ ...live, id: deletedId, baseAgent: 'not-a-harness' as 'claude' }],
      deletedCustomTuiAgents: [tombstone]
    }
    expect(customAgentSettingsBase(settings, deletedId)).toBe('codex')
  })

  it('reuses one index per published array (identity-memoized, not rebuilt per lookup)', () => {
    const rows = [live]
    const settings = { customTuiAgents: rows }
    expect(customAgentSettingsLabel(settings, liveId)).toBe('Reviewer')
    // In-place mutation is unsupported by contract: the store always replaces
    // the array. A stale hit here is the proof the index was not rebuilt.
    rows.push({ ...live, id: deletedId, baseAgent: 'codex', label: 'Late' })
    expect(customAgentSettingsLabel(settings, deletedId)).toBeNull()
    // A replaced array is a new identity and rebuilds once.
    expect(customAgentSettingsLabel({ customTuiAgents: [...rows] }, deletedId)).toBe('Late')
  })
})
