import { describe, expect, it } from 'vitest'
import {
  classifyNativeChatSend,
  getAgentSlashCommands,
  sessionSlashCommandSuggestions
} from './native-chat-slash-commands'

describe('OMP terminal command catalog', () => {
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
        { name: 'skill:', kind: 'command' },
        { name: 'plan', kind: 'skill' }
      ])
    ).toEqual([
      { name: 'model', description: 'Host model selector' },
      { name: 'custom' },
      { name: 'skill:' }
    ])
    expect(sessionSlashCommandSuggestions('omp', [])).toEqual([])
  })
})
