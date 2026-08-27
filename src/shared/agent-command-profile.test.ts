import { describe, expect, it } from 'vitest'
import { applyAgentCommandProfile, type AgentCommandProfile } from './agent-command-profile'

const PROFILES: AgentCommandProfile[] = [{ id: 'brq', label: 'Claude (brq)', cmd: 'claude-brq' }]

describe('applyAgentCommandProfile', () => {
  it('overrides the agent command when the profile id matches', () => {
    const result = applyAgentCommandProfile({}, 'claude', 'brq', PROFILES)
    expect(result).toEqual({ claude: 'claude-brq' })
  })

  it('preserves other agents already present in cmdOverrides', () => {
    const result = applyAgentCommandProfile({ codex: 'codex-custom' }, 'claude', 'brq', PROFILES)
    expect(result).toEqual({ codex: 'codex-custom', claude: 'claude-brq' })
  })

  it('returns cmdOverrides unchanged when profileId is null', () => {
    const base = { claude: 'claude-override' }
    expect(applyAgentCommandProfile(base, 'claude', null, PROFILES)).toBe(base)
  })

  it('returns cmdOverrides unchanged when profileId matches no profile', () => {
    const base = { claude: 'claude-override' }
    expect(applyAgentCommandProfile(base, 'claude', 'missing', PROFILES)).toBe(base)
  })

  it('returns cmdOverrides unchanged when agent is null', () => {
    const base = {}
    expect(applyAgentCommandProfile(base, null, 'brq', PROFILES)).toBe(base)
  })
})
