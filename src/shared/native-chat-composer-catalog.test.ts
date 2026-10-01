import { describe, expect, it } from 'vitest'
import {
  mobileComposerMenuRows,
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
    const catalog = nativeChatComposerCatalog('claude', {
      conversationCommands: ['clear']
    })
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
      {
        name: 'clear',
        description: 'Clear conversation history',
        kindUnspecified: true
      }
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
    expect(mobileComposerSlashEntries(catalog, '/').map((entry) => entry.name)).toEqual([
      'clear',
      'to-spec'
    ])
  })

  it('returns the command tier alone while no skills were reported', () => {
    const catalog = nativeChatComposerCatalog('claude', {
      conversationCommands: []
    })
    expect(mobileComposerSlashEntries(catalog, '/').map((entry) => entry.name)).toEqual([
      'model',
      'effort'
    ])
  })
})

describe('mobileComposerSlashEntries with discovered skills', () => {
  it('keeps a reported skill described from disk but drops a disk-only skill once a report arrived', () => {
    const catalog = nativeChatComposerCatalog('claude', {
      sessionCommands: [{ name: 'to-spec', kind: 'skill' }]
    })
    const entries = mobileComposerSlashEntries(catalog, '/', [
      { name: 'to-spec', description: 'Discovery duplicate' },
      { name: 'deploy-check', description: 'Verify the deploy' }
    ])
    expect(entries).toEqual([{ name: 'to-spec', description: 'Discovery duplicate' }])
  })

  it('offers every discovered skill while no report has arrived', () => {
    const catalog = nativeChatComposerCatalog('claude')
    const entries = mobileComposerSlashEntries(catalog, '/', [
      { name: 'to-spec', description: 'Turn the discussion into a spec' },
      { name: 'deploy-check', description: 'Verify the deploy' }
    ])
    // The curated PTY-lane commands lead; both disk skills still join them.
    expect(entries).toContainEqual({
      name: 'to-spec',
      description: 'Turn the discussion into a spec'
    })
    expect(entries).toContainEqual({
      name: 'deploy-check',
      description: 'Verify the deploy'
    })
  })

  it('keeps an on-disk skill an unclassified command names, even absent from the report', () => {
    const catalog = nativeChatComposerCatalog('claude', {
      sessionCommands: [
        { name: 'clear', kind: 'command' },
        { name: 'grill', kind: 'command', kindUnspecified: true }
      ]
    })
    const entries = mobileComposerSlashEntries(catalog, '/', [
      { name: 'grill', description: 'Stress-test the plan' },
      { name: 'deploy-check', description: 'Verify the deploy' }
    ])
    expect(entries).toEqual([
      { name: 'clear', description: 'Clear conversation history' },
      { name: 'grill', description: 'Stress-test the plan' }
    ])
  })

  it('collapses a skill the discovery lists through several roots, keeping the described row', () => {
    const catalog = nativeChatComposerCatalog('claude')
    const entries = mobileComposerSlashEntries(catalog, '/', [
      { name: 'to-spec' },
      { name: 'to-spec', description: 'Turn the discussion into a spec' }
    ])
    expect(entries.filter((entry) => entry.name === 'to-spec')).toEqual([
      { name: 'to-spec', description: 'Turn the discussion into a spec' }
    ])
  })
})

describe('mobileComposerMenuRows', () => {
  it('marks an unclassified command that merged onto its skill row as the skill', () => {
    const catalog = nativeChatComposerCatalog('claude', {
      sessionCommands: [
        { name: 'clear', kind: 'command' },
        { name: 'grill', kind: 'command', kindUnspecified: true },
        { name: 'grill', kind: 'skill' }
      ]
    })
    expect(mobileComposerMenuRows(catalog, '/', [{ name: 'grill' }])).toEqual([
      {
        kind: 'command',
        entry: { name: 'clear', description: 'Clear conversation history' }
      },
      { kind: 'skill', entry: { name: 'grill' } }
    ])
  })

  it('keeps an unclassified command that stayed a command row as a command', () => {
    const catalog = nativeChatComposerCatalog('claude', {
      sessionCommands: [{ name: 'frobnicate', kind: 'command', kindUnspecified: true }]
    })
    expect(mobileComposerMenuRows(catalog, '/')).toEqual([
      { kind: 'command', entry: { name: 'frobnicate', kindUnspecified: true } }
    ])
  })

  it('keeps a curated command and a same-named PTY-lane skill as two rows under $', () => {
    const catalog = nativeChatComposerCatalog('codex')
    const reviewRows = mobileComposerMenuRows(catalog, '$', [
      { name: 'review', description: 'Inspect the change' }
    ]).filter((row) => row.entry.name === 'review')
    expect(reviewRows).toEqual([
      {
        kind: 'command',
        entry: { name: 'review', description: 'Review the current changes' }
      },
      {
        kind: 'skill',
        entry: { name: 'review', description: 'Inspect the change' }
      }
    ])
  })

  it('keeps only the command row for a shared-sigil name collision', () => {
    const catalog = nativeChatComposerCatalog('codex')
    const reviewRows = mobileComposerMenuRows(catalog, '/', [
      { name: 'review', description: 'Inspect the change' }
    ]).filter((row) => row.entry.name === 'review')
    expect(reviewRows).toEqual([
      {
        kind: 'command',
        entry: { name: 'review', description: 'Review the current changes' }
      }
    ])
  })
})

describe('mobileComposerSlashEntries with namespaced plugin skills', () => {
  it('keeps a plugin skill distinct from a same-named home skill', () => {
    const catalog = nativeChatComposerCatalog('claude')
    const entries = mobileComposerSlashEntries(catalog, '/', [
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
    const entries = mobileComposerSlashEntries(catalog, '/', [
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
    const entries = mobileComposerSlashEntries(catalog, '/', [
      { name: 'grill', description: 'Stress-test the plan' }
    ])
    expect(entries).toEqual([
      { name: 'clear', description: 'Clear conversation history' },
      { name: 'grill', description: 'Stress-test the plan' }
    ])
  })
})

describe('mobileComposerSlashEntries unclassified without disk copy', () => {
  it('keeps the reported skill when the colliding command is unclassified and discovery has nothing', () => {
    const catalog = nativeChatComposerCatalog('claude', {
      sessionCommands: [
        { name: 'clear', kind: 'command' },
        { name: 'grill', kind: 'command', kindUnspecified: true },
        { name: 'grill', kind: 'skill' }
      ]
    })
    expect(mobileComposerSlashEntries(catalog, '/')).toEqual([
      { name: 'clear', description: 'Clear conversation history' },
      { name: 'grill' }
    ])
  })
})
