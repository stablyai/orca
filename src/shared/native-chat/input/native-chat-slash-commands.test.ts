import { describe, expect, it } from 'vitest'
import {
  getAgentSlashCommands,
  mergeDiscoveredSlashCommands,
  sessionSlashCommandSuggestions
} from './native-chat-slash-commands'

describe('a session that reports its own command surface', () => {
  const reported = [
    { name: 'clear', kind: 'command' as const },
    { name: 'opsx:apply', kind: 'command' as const },
    { name: 'ref-oss', kind: 'skill' as const }
  ]

  it('offers exactly the reported commands, described from the curated catalog', () => {
    expect(sessionSlashCommandSuggestions('claude', reported)).toEqual([
      { name: 'clear', description: 'Clear conversation history' },
      { name: 'opsx:apply' }
    ])
  })
})

describe('mergeDiscoveredSlashCommands', () => {
  const discovered = (name: string, description: string | null = null) => ({
    name,
    description,
    scope: 'project' as const,
    commandFilePath: `/repo/.claude/commands/${name}.md`
  })

  it('appends discovered commands to the curated catalog', () => {
    const merged = mergeDiscoveredSlashCommands(getAgentSlashCommands('claude'), [
      discovered('opsx:apply', 'Apply a change')
    ])
    expect(merged.find((command) => command.name === 'opsx:apply')?.description).toBe(
      'Apply a change'
    )
  })

  it('keeps the built-in when a custom command shadows its name', () => {
    const merged = mergeDiscoveredSlashCommands(
      [{ name: 'review', description: 'Review the current changes' }],
      [discovered('review', 'Custom review')]
    )
    expect(merged).toEqual([{ name: 'review', description: 'Review the current changes' }])
  })

  it('drops filesystem names that are not typeable as one slash token', () => {
    expect(mergeDiscoveredSlashCommands([], [discovered('two words')])).toEqual([])
    expect(mergeDiscoveredSlashCommands([], [discovered('review\u200d')])).toEqual([])
  })

  it('sanitizes author-controlled descriptions', () => {
    const merged = mergeDiscoveredSlashCommands([], [discovered('opsx:apply', 'a\u202eb')])
    expect(merged[0].description).toBe('ab')
  })
})
