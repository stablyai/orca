import { describe, expect, it } from 'vitest'
import {
  SKILLS_CLI_AGENT_KEY_BY_TUI_AGENT,
  isUsableSkillsCliAgentKey,
  toRequestedSkillsCliAgentKey,
  toSkillsCliAgentKeys
} from './skills-cli-agent-keys'

describe('skills CLI agent keys', () => {
  it('rejects values the skills CLI would drop, and allows the explicit wildcard', () => {
    for (const bad of ['-y', '--copy', '', ' ', 'a b', 'a,b']) {
      expect(isUsableSkillsCliAgentKey(bad), bad).toBe(false)
    }
    for (const good of ['claude-code', 'universal', 'trae-cn', 'inference-sh', '*']) {
      expect(isUsableSkillsCliAgentKey(good), good).toBe(true)
    }
  })

  it('always includes the shared directory and drops unmappable agents', () => {
    expect(toSkillsCliAgentKeys(['claude', 'rovo'])).toEqual([
      'claude-code',
      'rovodev',
      'universal'
    ])
    // Why: `omp` has no skills-CLI equivalent, so it must not reach the argv.
    expect(toSkillsCliAgentKeys(['omp'])).toEqual(['universal'])
    expect(toSkillsCliAgentKeys([])).toEqual(['universal'])
  })

  it('maps a typed Orca agent id unless the skills CLI already owns that key', () => {
    for (const [agent, key] of Object.entries(SKILLS_CLI_AGENT_KEY_BY_TUI_AGENT)) {
      // Why: an id that is itself a valid skills key (only `trae`) keeps the CLI's meaning.
      const expected = key === null || agent === 'trae' ? agent : key
      expect(toRequestedSkillsCliAgentKey(agent), agent).toBe(expected)
    }
    expect(toRequestedSkillsCliAgentKey('claude')).toBe('claude-code')
    expect(toRequestedSkillsCliAgentKey('trae')).toBe('trae')
    for (const passthrough of ['claude-code', 'universal', '*', 'Claude', 'inference-sh']) {
      expect(toRequestedSkillsCliAgentKey(passthrough), passthrough).toBe(passthrough)
    }
  })
})
