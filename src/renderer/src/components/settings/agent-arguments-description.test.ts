import { describe, expect, it } from 'vitest'
import { agentArgumentsDescription } from './agent-arguments-description'

describe('agentArgumentsDescription', () => {
  it.each([
    ['claude', '~/.claude/settings.json'],
    ['codex', '~/.codex/config.toml'],
    ['grok', '~/.grok/config.toml'],
    ['opencode', '~/.config/opencode/opencode.json']
  ] as const)('tells %s users where chat settings go instead', (agent, configFile) => {
    expect(agentArgumentsDescription(agent)).toContain("The updated native chat doesn't use these")
    expect(agentArgumentsDescription(agent)).toContain(configFile)
  })

  it('names no file for an agent whose config Orca has not verified', () => {
    expect(agentArgumentsDescription('omp')).toBe(
      "Used in terminal tabs and terminal chats. The updated native chat doesn't use these."
    )
  })

  // Agents with only terminal chats launch with these Arguments everywhere.
  it('says nothing for an agent without the updated native chat', () => {
    expect(agentArgumentsDescription('gemini')).toBeUndefined()
  })
})
