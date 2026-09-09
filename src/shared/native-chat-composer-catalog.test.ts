import { describe, expect, it } from 'vitest'
import {
  mobileComposerSlashEntries,
  nativeChatComposerCatalog
} from './native-chat-composer-catalog'
import { getVerifiedNativeChatCommands } from './native-chat-agent-profiles'

describe('nativeChatComposerCatalog lane selection', () => {
  it('keeps the PTY lane on the verified per-agent catalog with no skill names', () => {
    const catalog = nativeChatComposerCatalog('claude')
    expect(catalog).toEqual({
      agentCommands: getVerifiedNativeChatCommands('claude'),
      sessionSkillNames: undefined
    })
    const names = catalog.agentCommands.map((command) => command.name)
    expect(names).toContain('clear')
    expect(names).toContain('compact')
  })

  it('keeps a structured host that predates the report on the structured base commands', () => {
    expect(nativeChatComposerCatalog('claude', {})).toEqual({
      agentCommands: [
        { name: 'model', description: 'Choose the model' },
        { name: 'effort', description: 'Choose reasoning effort' }
      ],
      sessionSkillNames: undefined
    })
  })

  it('offers only host-supported conversation commands before any report arrives', () => {
    const catalog = nativeChatComposerCatalog('claude', { conversationCommands: ['clear'] })
    expect(catalog.agentCommands.map((command) => command.name)).toEqual([
      'model',
      'effort',
      'clear'
    ])
  })
})

describe('nativeChatComposerCatalog report authority', () => {
  const reported = [
    { name: 'clear', kind: 'command' as const },
    { name: 'opsx:apply', kind: 'command' as const },
    { name: 'ref-oss', kind: 'skill' as const }
  ]

  it('replaces the curated catalog with the report, described from curated entries', () => {
    expect(nativeChatComposerCatalog('claude', { sessionCommands: reported })).toEqual({
      agentCommands: [
        { name: 'clear', description: 'Clear conversation history' },
        { name: 'opsx:apply' }
      ],
      sessionSkillNames: ['ref-oss']
    })
  })

  it('respects an empty report as authoritative rather than falling back to curated', () => {
    expect(nativeChatComposerCatalog('claude', { sessionCommands: [] })).toEqual({
      agentCommands: [],
      sessionSkillNames: []
    })
  })

  it('preserves kindUnspecified on reported commands', () => {
    const catalog = nativeChatComposerCatalog('claude', {
      sessionCommands: [{ name: 'clear', kind: 'command', kindUnspecified: true }]
    })
    expect(catalog.agentCommands).toEqual([
      { name: 'clear', description: 'Clear conversation history', kindUnspecified: true }
    ])
  })
})

describe('mobileComposerSlashEntries', () => {
  it('appends reported skills after commands, deduped against command names', () => {
    const catalog = nativeChatComposerCatalog('claude', {
      sessionCommands: [
        { name: 'clear', kind: 'command' },
        { name: 'clear', kind: 'skill' },
        { name: 'to-spec', kind: 'skill' }
      ]
    })
    expect(mobileComposerSlashEntries(catalog).map((entry) => entry.name)).toEqual([
      'clear',
      'to-spec'
    ])
  })

  it('returns the command tier alone while no skills were reported', () => {
    const catalog = nativeChatComposerCatalog('claude', { conversationCommands: [] })
    expect(mobileComposerSlashEntries(catalog).map((entry) => entry.name)).toEqual([
      'model',
      'effort'
    ])
  })
})

describe('mobileComposerSlashEntries with discovered skills', () => {
  it('appends discovered skills with descriptions, deduped by name', () => {
    const catalog = nativeChatComposerCatalog('claude', {
      sessionCommands: [{ name: 'to-spec', kind: 'skill' }]
    })
    const entries = mobileComposerSlashEntries(catalog, [
      { name: 'to-spec', description: 'Discovery duplicate' },
      { name: 'deploy-check', description: 'Verify the deploy' }
    ])
    expect(entries).toEqual([
      { name: 'to-spec', description: 'Discovery duplicate' },
      { name: 'deploy-check', description: 'Verify the deploy' }
    ])
  })

  it('collapses a skill the discovery lists through several roots, keeping the described row', () => {
    const catalog = nativeChatComposerCatalog('claude')
    const entries = mobileComposerSlashEntries(catalog, [
      { name: 'to-spec' },
      { name: 'to-spec', description: 'Turn the discussion into a spec' }
    ])
    expect(entries.filter((entry) => entry.name === 'to-spec')).toEqual([
      { name: 'to-spec', description: 'Turn the discussion into a spec' }
    ])
  })
})

describe('mobileComposerSlashEntries with namespaced plugin skills', () => {
  it('keeps a plugin skill distinct from a same-named home skill', () => {
    const catalog = nativeChatComposerCatalog('claude')
    const entries = mobileComposerSlashEntries(catalog, [
      { name: 'grilling', description: 'Home copy' },
      { name: 'quiver:grilling', description: 'Plugin copy' }
    ])
    expect(entries.map((entry) => entry.name).filter((name) => name.includes('grilling'))).toEqual([
      'grilling',
      'quiver:grilling'
    ])
  })
})

describe('mobileComposerSlashEntries desktop parity', () => {
  it('keeps a discovered description on a session-reported skill', () => {
    const catalog = nativeChatComposerCatalog('claude', {
      sessionCommands: [{ name: 'to-spec', kind: 'skill' }]
    })
    const entries = mobileComposerSlashEntries(catalog, [
      { name: 'to-spec', description: 'Turn the discussion into a spec' }
    ])
    expect(entries).toEqual([{ name: 'to-spec', description: 'Turn the discussion into a spec' }])
  })

  it('renders a kindUnspecified command that names a skill as the skill row', () => {
    const catalog = nativeChatComposerCatalog('claude', {
      sessionCommands: [
        { name: 'clear', kind: 'command' },
        { name: 'grill', kind: 'command', kindUnspecified: true },
        { name: 'grill', kind: 'skill' }
      ]
    })
    const entries = mobileComposerSlashEntries(catalog, [
      { name: 'grill', description: 'Stress-test the plan' }
    ])
    expect(entries).toEqual([
      { name: 'clear', description: 'Clear conversation history' },
      { name: 'grill', description: 'Stress-test the plan' }
    ])
  })
})
