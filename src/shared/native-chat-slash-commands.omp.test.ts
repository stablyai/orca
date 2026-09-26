import { describe, expect, it } from 'vitest'
import {
  getNativeChatAgentProfile,
  getVerifiedNativeChatCommands
} from './native-chat-agent-profiles'
import {
  applySlashSuggestion,
  classifyNativeChatSend,
  filterSlashCommands,
  getAgentSlashCommands,
  sessionSlashCommandSuggestions,
  slashCommandDispatchText
} from './native-chat-slash-commands'

describe('OMP terminal command catalog', () => {
  it('offers the verified model, planning and context commands without generic help', () => {
    const commands = getAgentSlashCommands('omp')
    const names = commands.map((command) => command.name)
    expect(names).toEqual(
      expect.arrayContaining(['model', 'switch', 'plan', 'compact', 'context', 'usage'])
    )
    expect(names).not.toContain('help')
    expect(getVerifiedNativeChatCommands('omp')).toEqual(commands)
    expect(getNativeChatAgentProfile('omp')).toBeNull()
    expect(new Set(names).size).toBe(names.length)
    expect(getAgentSlashCommands('pi').map((command) => command.name)).toEqual(['clear', 'help'])
  })

  it('completes arguments separately from picker command dispatch', () => {
    const matches = filterSlashCommands(getAgentSlashCommands('omp'), 'MOD')
    expect(matches).toHaveLength(1)
    const command = matches[0]
    if (!command) {
      throw new Error('Expected an OMP model suggestion')
    }
    expect(command.name).toBe('model')
    expect(applySlashSuggestion(command)).toBe('/model ')
    expect(slashCommandDispatchText(command)).toBe('/model')
  })

  it('classifies known OMP commands as terminal actions, preserving unknown and prose paths', () => {
    const commands = getAgentSlashCommands('omp')
    expect(classifyNativeChatSend('/compact focus on tests', commands, null, null)).toBe('command')
    expect(classifyNativeChatSend('/model', commands, null, null)).toBe('command')
    expect(classifyNativeChatSend('/help', commands, null, null)).toBe('unknown-token')
    expect(classifyNativeChatSend(' /model', commands, null, null)).toBe('chat')
    expect(classifyNativeChatSend('/plan', commands, '/plan', '/')).toBe('chat')
  })

  it('lets a session command report replace the curated set and descriptions', () => {
    expect(
      sessionSlashCommandSuggestions('omp', [
        { name: 'model', kind: 'command', description: 'Host model selector' },
        { name: 'custom', kind: 'command' },
        { name: 'plan', kind: 'skill' }
      ])
    ).toEqual([{ name: 'model', description: 'Host model selector' }, { name: 'custom' }])
    expect(sessionSlashCommandSuggestions('omp', [])).toEqual([])
  })
})
