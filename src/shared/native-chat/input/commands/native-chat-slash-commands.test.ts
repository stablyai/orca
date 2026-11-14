import { describe, expect, it } from 'vitest'
import { sessionSlashCommandSuggestions } from './native-chat-slash-commands'

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
