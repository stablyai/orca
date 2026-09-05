import { describe, expect, it } from 'vitest'
import {
  classifyNativeChatSend,
  filterSlashCommands,
  getAgentSlashCommands
} from './native-chat-slash-commands'

describe('ZeroClaw native chat slash commands', () => {
  it('returns specific slash commands for zeroclaw agent', () => {
    const commands = getAgentSlashCommands('zeroclaw')
    const names = commands.map((c) => c.name)

    expect(names).toContain('skills')
    expect(names).toContain('model')
    expect(names).toContain('swarm')
    expect(names).toContain('cron')
    expect(names).toContain('context')
    expect(names).toContain('mcp')
    expect(names).toContain('review')
    expect(names).toContain('clear')
    expect(names).toContain('help')
  })

  it('filters ZeroClaw slash commands by prefix', () => {
    const commands = getAgentSlashCommands('zeroclaw')

    const sMatches = filterSlashCommands(commands, 's')
    expect(sMatches.map((c) => c.name)).toEqual(['skills', 'swarm'])

    const mMatches = filterSlashCommands(commands, 'm')
    expect(mMatches.map((c) => c.name)).toEqual(['model', 'mcp'])

    const emptyMatches = filterSlashCommands(commands, '')
    expect(emptyMatches.length).toBe(commands.length)
  })

  it('classifies ZeroClaw slash commands correctly', () => {
    const commands = getAgentSlashCommands('zeroclaw')

    expect(classifyNativeChatSend('/skills', commands, null, '/')).toBe('command')
    expect(classifyNativeChatSend('/swarm 4', commands, null, '/')).toBe('command')
    expect(classifyNativeChatSend('/unknown', commands, null, '/')).toBe('unknown-token')
    expect(classifyNativeChatSend('Hello ZeroClaw', commands, null, '/')).toBe('chat')
  })
})
