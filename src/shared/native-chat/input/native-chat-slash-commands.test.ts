import { describe, expect, it } from 'vitest'
import { sessionReportedSkills, sessionSlashCommandSuggestions } from './native-chat-slash-commands'

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
