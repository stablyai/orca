import { describe, expect, it } from 'vitest'
import { getAgentSlashCommands, mergeDiscoveredSlashCommands } from './native-chat-slash-commands'
import { nativeChatCommandsForAgent } from './native-chat-skill-visibility'

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

describe('nativeChatCommandsForAgent', () => {
  const commands = [
    {
      name: 'opsx:apply',
      description: null,
      scope: 'project' as const,
      commandFilePath: '/repo/.claude/commands/opsx/apply.md'
    }
  ]

  it('surfaces scanned commands for Claude-owned panes', () => {
    expect(nativeChatCommandsForAgent('claude', 'ready', commands)).toEqual(commands)
    expect(nativeChatCommandsForAgent('openclaude', 'ready', commands)).toEqual(commands)
  })

  it('withholds them from panes of other agents', () => {
    expect(nativeChatCommandsForAgent('codex', 'ready', commands)).toEqual([])
    expect(nativeChatCommandsForAgent('opencode', 'ready', commands)).toEqual([])
  })

  it('is empty before the scan is ready and when the host never scanned commands', () => {
    expect(nativeChatCommandsForAgent('claude', 'loading', commands)).toEqual([])
    expect(nativeChatCommandsForAgent('claude', 'ready', undefined)).toEqual([])
  })
})
