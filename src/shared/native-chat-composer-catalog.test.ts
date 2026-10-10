import { describe, expect, it } from 'vitest'
import { nativeChatComposerCatalog } from './native-chat-composer-catalog'
import { getVerifiedNativeChatCommands } from './native-chat-agent-profiles'

const names = (commands: readonly { name: string }[]): string[] => commands.map(({ name }) => name)

describe('nativeChatComposerCatalog', () => {
  it('serves the terminal lane the curated list its surface passes, and no session skills', () => {
    const curated = getVerifiedNativeChatCommands('claude')
    expect(nativeChatComposerCatalog('claude', curated)).toEqual({
      agentCommands: curated,
      sessionSkills: undefined
    })
  })

  it('falls back to host-owned commands when a structured host sends no report', () => {
    const full = nativeChatComposerCatalog('claude', [], {
      conversationCommands: ['clear', 'compact']
    })
    expect(names(full.agentCommands)).toEqual(['model', 'effort', 'clear', 'compact'])
    expect(full.sessionSkills).toBeUndefined()
    expect(
      names(nativeChatComposerCatalog('claude', [], { conversationCommands: [] }).agentCommands)
    ).toEqual(['model', 'effort'])
    expect(names(nativeChatComposerCatalog('claude', [], {}).agentCommands)).toEqual([
      'model',
      'effort'
    ])
  })

  it('keeps the commands Codex runs from message text when it has no report', () => {
    const catalog = nativeChatComposerCatalog('codex', [], { conversationCommands: [] })
    expect(names(catalog.agentCommands)).toContain('goal')
    expect(catalog.sessionSkills).toBeUndefined()
  })

  it('takes commands and skills from the session report, with its text', () => {
    const catalog = nativeChatComposerCatalog('claude', [], {
      conversationCommands: ['clear', 'compact'],
      sessionCommands: [
        { name: 'review', kind: 'command', description: 'Review a PR', argumentHint: '<pr>' },
        { name: 'clear', kind: 'command' },
        { name: 'opsx:apply', kind: 'command', kindUnspecified: true },
        { name: 'triage', kind: 'skill', description: 'Sort issues' }
      ]
    })
    expect(catalog.agentCommands).toEqual([
      { name: 'review', description: 'Review a PR', argumentHint: '<pr>' },
      { name: 'clear', description: 'Clear conversation history' },
      { name: 'opsx:apply', kindUnspecified: true }
    ])
    expect(catalog.sessionSkills).toEqual([{ name: 'triage', description: 'Sort issues' }])
  })

  it('treats an empty report as authoritative instead of reviving the fallback', () => {
    expect(
      nativeChatComposerCatalog('claude', [], {
        sessionCommands: [],
        conversationCommands: ['clear', 'compact']
      })
    ).toEqual({ agentCommands: [], sessionSkills: [] })
  })

  it('handles command-only and skill-only reports', () => {
    expect(
      nativeChatComposerCatalog('claude', [], {
        sessionCommands: [{ name: 'custom-command', kind: 'command' }]
      })
    ).toEqual({ agentCommands: [{ name: 'custom-command' }], sessionSkills: [] })
    expect(
      nativeChatComposerCatalog('claude', [], {
        sessionCommands: [{ name: 'only', kind: 'skill' }]
      })
    ).toEqual({ agentCommands: [], sessionSkills: [{ name: 'only' }] })
  })
})
