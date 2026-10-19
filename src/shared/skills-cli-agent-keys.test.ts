import { describe, expect, it } from 'vitest'
import { isUsableSkillsCliAgentKey, toSkillsCliAgentKeys } from './skills-cli-agent-keys'

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
})
