import { describe, expect, it } from 'vitest'
import {
  filterSlashCommands,
  getAgentSlashCommands,
  sessionReportedSkills,
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

  it('splits skills out for the picker to group on its own', () => {
    expect(sessionReportedSkills(reported).map((skill) => skill.name)).toEqual(['ref-oss'])
  })

  it('prefers the description the session reported over the curated one', () => {
    expect(
      sessionSlashCommandSuggestions('claude', [
        { name: 'clear', kind: 'command', description: 'Wipe the transcript' },
        { name: 'goal', kind: 'command', description: 'Set or view the goal' },
        { name: 'compact', kind: 'command' }
      ])
    ).toEqual([
      { name: 'clear', description: 'Wipe the transcript' },
      { name: 'goal', description: 'Set or view the goal' },
      { name: 'compact', description: 'Summarize and compact the conversation' }
    ])
  })

  it('keeps a reported description and argument hint the curated catalog never claims', () => {
    expect(
      sessionSlashCommandSuggestions('codex', [
        {
          name: 'opsx:apply',
          kind: 'command',
          description: 'Apply the plan',
          argumentHint: '<plan-id>',
          kindUnspecified: true
        }
      ])
    ).toEqual([
      {
        name: 'opsx:apply',
        description: 'Apply the plan',
        argumentHint: '<plan-id>',
        kindUnspecified: true
      }
    ])
  })
})

describe('curated agent slash commands', () => {
  it('includes /mcp in Claude Code slash commands with description', () => {
    const claudeCommands = getAgentSlashCommands('claude')
    expect(claudeCommands).toContainEqual({
      name: 'mcp',
      description: 'List configured MCP tools'
    })
  })

  it('includes /mcp in OpenClaude commands via inherited Claude catalog', () => {
    const openClaudeCommands = getAgentSlashCommands('openclaude')
    expect(openClaudeCommands).toContainEqual({
      name: 'mcp',
      description: 'List configured MCP tools'
    })
  })

  it('populates curated description when session reports /mcp for Claude', () => {
    expect(sessionSlashCommandSuggestions('claude', [{ name: 'mcp', kind: 'command' }])).toEqual([
      { name: 'mcp', description: 'List configured MCP tools' }
    ])
  })

  it('matches /mcp through prefix filtering in Claude commands', () => {
    const matches = filterSlashCommands(getAgentSlashCommands('claude'), 'mc')
    expect(matches).toEqual([{ name: 'mcp', description: 'List configured MCP tools' }])
  })
})
