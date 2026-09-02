import { describe, expect, it } from 'vitest'
import { AgentSkillShareRequestSchema } from './agent-skill-sharing-contract'

describe('agent skill sharing contract', () => {
  it('accepts a Windows discovery cwd without assuming POSIX separators', () => {
    expect(
      AgentSkillShareRequestSchema.parse({
        skillSelectors: ['alpha'],
        bundleName: 'team-skills',
        target: { cwd: 'C:\\Users\\alice\\repo' }
      }).target?.cwd
    ).toBe('C:\\Users\\alice\\repo')
  })

  it('rejects arbitrary source paths and more than 512 explicit selectors', () => {
    expect(
      AgentSkillShareRequestSchema.safeParse({
        skillSelectors: ['alpha'],
        bundleName: 'team-skills',
        sourceDirectory: '/private/skill'
      }).success
    ).toBe(false)
    expect(
      AgentSkillShareRequestSchema.safeParse({
        skillSelectors: Array.from({ length: 513 }, (_, index) => `skill-${index}`),
        bundleName: 'team-skills'
      }).success
    ).toBe(false)
  })
})
