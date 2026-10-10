import { describe, expect, it } from 'vitest'
import { buildNativeChatPickerItems } from './native-chat-picker-items'
import {
  sessionSlashCommandSuggestions,
  type SlashCommandSuggestion
} from './native-chat-slash-commands'
import type { DiscoveredSkill } from './skills'

const COMMANDS: SlashCommandSuggestion[] = [
  { name: 'clear' },
  { name: 'compact' },
  { name: 'help' }
]

function skill(overrides: Partial<DiscoveredSkill>): DiscoveredSkill {
  return {
    id: overrides.name ?? 'skill',
    name: 'typescript',
    description: null,
    providers: ['codex'],
    sourceKind: 'repo',
    sourceLabel: 'Repository',
    rootPath: '/repo/.agents/skills',
    directoryPath: '/repo/.agents/skills/typescript',
    skillFilePath: '/repo/.agents/skills/typescript/SKILL.md',
    installed: true,
    updatedAt: null,
    ...overrides
  }
}

describe('buildNativeChatPickerItems', () => {
  it('lets a session report replace the disk scan and enrich the names it knows', () => {
    const items = buildNativeChatPickerItems(
      [],
      [
        skill({
          name: 'triage',
          description: 'On disk',
          skillFilePath: '/home/triage/SKILL.md',
          sourceKind: 'home'
        }),
        skill({ name: 'stale-on-disk', skillFilePath: '/home/stale/SKILL.md', sourceKind: 'home' })
      ],
      '',
      '/',
      [{ name: 'dataviz' }, { name: 'triage' }]
    )
    // The scanned-but-unreported skill is gone; the reported-but-unscanned one is
    // offered without a scope, and sorts after the one the scan located.
    expect(items.map((item) => item.name)).toEqual(['triage', 'dataviz'])
    expect(items[0]).toMatchObject({ kind: 'skill', description: 'On disk' })
    expect(items[1]).toMatchObject({ kind: 'skill', description: null, sources: [] })
  })

  it('keeps the disk scan only when a session report is absent', () => {
    const items = buildNativeChatPickerItems(
      [],
      [skill({ name: 'triage', skillFilePath: '/home/triage/SKILL.md' })],
      '',
      '/',
      undefined
    )
    expect(items.map((item) => item.name)).toEqual(['triage'])
    expect(buildNativeChatPickerItems([], [skill({})], '', '/', [])).toEqual([])
  })

  it('rejects a session-reported name that is not a safe insertion token', () => {
    const items = buildNativeChatPickerItems([], [], '', '/', [
      { name: 'ok' },
      { name: 'two words' },
      { name: 'cle\u200bar' }
    ])
    expect(items.map((item) => item.name)).toEqual(['ok'])
  })

  it('drops a session-reported command whose name would insert hidden text', () => {
    const commands = sessionSlashCommandSuggestions('claude', [
      { name: 'review', kind: 'command' },
      { name: 'evil\nrm -rf', kind: 'command' },
      { name: 'evil\u202Eexe', kind: 'command' },
      { name: 'evil\u200Bhidden', kind: 'command' }
    ])
    const items = buildNativeChatPickerItems(commands, [], '', '/')
    expect(items.map((item) => item.token)).toEqual(['/review'])
    expect(buildNativeChatPickerItems(commands, [], 'evil', '/')).toEqual([])
  })

  it('ranks exact, prefix, fuzzy, then description matches within a group', () => {
    const items = buildNativeChatPickerItems(
      [],
      [
        skill({ name: 'deploy', skillFilePath: '/1/SKILL.md' }),
        skill({ name: 'deployment', skillFilePath: '/2/SKILL.md' }),
        skill({ name: 'd-e-p-l-o-y', skillFilePath: '/3/SKILL.md' }),
        skill({
          name: 'release',
          description: 'Deploy an application',
          skillFilePath: '/4/SKILL.md'
        })
      ],
      'deploy',
      '$'
    )
    expect(items.map((item) => item.name)).toEqual([
      'deploy',
      'deployment',
      'd-e-p-l-o-y',
      'release'
    ])
  })

  it('merges duplicate names but annotates command collisions on one command row', () => {
    const duplicateSkills = [
      skill({ name: 'clear', skillFilePath: '/project/clear/SKILL.md', sourceKind: 'repo' }),
      skill({ name: 'clear', skillFilePath: '/home/clear/SKILL.md', sourceKind: 'home' })
    ]
    const skillOnly = buildNativeChatPickerItems([], duplicateSkills, '', '$')
    expect(skillOnly).toEqual([
      expect.objectContaining({ kind: 'skill', name: 'clear', sources: expect.any(Array) })
    ])
    expect(skillOnly[0].kind === 'skill' ? skillOnly[0].sources : []).toHaveLength(2)

    const collision = buildNativeChatPickerItems(COMMANDS, duplicateSkills, 'clear', '/')
    expect(collision).toEqual([
      expect.objectContaining({ kind: 'command', name: 'clear', skillCollision: true })
    ])
  })

  it('rejects names carrying zero-width characters instead of inserting them', () => {
    const items = buildNativeChatPickerItems(
      [],
      [
        skill({
          name: 'cle\u200bar',
          directoryPath: '/repo/.agents/skills/safe-dir',
          skillFilePath: '/repo/.agents/skills/safe-dir/SKILL.md'
        })
      ],
      '',
      '$'
    )
    expect(items.map((item) => item.name)).toEqual(['safe-dir'])
  })

  it('falls back to a token-safe directory name and strips unsafe display text', () => {
    const items = buildNativeChatPickerItems(
      [],
      [
        skill({
          name: 'Spoof\u202e Name',
          directoryPath: '/repo/.agents/skills/safe-name',
          skillFilePath: '/repo/.agents/skills/safe-name/SKILL.md'
        })
      ],
      '',
      '$'
    )
    expect(items.map((item) => item.name)).toEqual(['safe-name'])
  })

  it('describes a session skill with no disk match by what the session reported', () => {
    const items = buildNativeChatPickerItems([], [], '', '/', [
      { name: 'dataviz', description: 'Build charts' },
      { name: 'bare' }
    ])
    expect(items).toEqual([
      expect.objectContaining({ kind: 'skill', name: 'bare', description: null }),
      expect.objectContaining({ kind: 'skill', name: 'dataviz', description: 'Build charts' })
    ])
  })

  it('keeps the disk description over the reported one, and fills a blank disk one', () => {
    const items = buildNativeChatPickerItems(
      [],
      [
        skill({ name: 'triage', description: 'On disk', skillFilePath: '/a/SKILL.md' }),
        skill({ name: 'blank', description: null, skillFilePath: '/b/SKILL.md' })
      ],
      '',
      '/',
      [
        { name: 'triage', description: 'Reported' },
        { name: 'blank', description: 'Reported blank' }
      ]
    )
    expect(items.find((item) => item.name === 'triage')?.description).toBe('On disk')
    expect(items.find((item) => item.name === 'blank')).toMatchObject({
      description: 'Reported blank',
      sources: [{ sourceKind: 'repo' }]
    })
  })

  it('finds a disk-less session skill by its reported description', () => {
    const items = buildNativeChatPickerItems([], [], 'charts', '/', [
      { name: 'dataviz', description: 'Build charts' },
      { name: 'other' }
    ])
    expect(items.map((item) => item.name)).toEqual(['dataviz'])
  })

  it('strips unsafe display characters from a reported description', () => {
    const [item] = buildNativeChatPickerItems([], [], '', '/', [
      { name: 'spoof', description: 'safe\u202e text' }
    ])
    expect(item?.description).toBe('safe text')
  })

  it('drops an unclassified command whose name is a skill under a shared `/`', () => {
    const commands = sessionSlashCommandSuggestions('claude', [
      { name: 'review', kind: 'command', kindUnspecified: true }
    ])
    const shared = buildNativeChatPickerItems(commands, [], '', '/', [{ name: 'review' }])
    expect(shared.map(({ kind, token }) => ({ kind, token }))).toEqual([
      { kind: 'skill', token: '/review' }
    ])
    const distinct = buildNativeChatPickerItems(COMMANDS, [], '', '$', [{ name: 'clear' }])
    expect(distinct.map((item) => item.token)).toEqual(['/clear', '/compact', '/help', '$clear'])
    expect(distinct[0]).toMatchObject({ kind: 'command', skillCollision: false })
  })

  it('caps each group at 50 rows after filtering the whole report', () => {
    const commands = Array.from({ length: 200 }, (_, index) => ({
      name: `cmd-${String(index).padStart(3, '0')}`
    }))
    const sessionSkills = Array.from({ length: 200 }, (_, index) => ({
      name: `skill-${String(index).padStart(3, '0')}`
    }))
    const items = buildNativeChatPickerItems(commands, [], '', '/', sessionSkills)
    expect(items.filter((item) => item.kind === 'command')).toHaveLength(50)
    expect(items.filter((item) => item.kind === 'skill')).toHaveLength(50)
    const filtered = buildNativeChatPickerItems(commands, [], 'cmd-150', '/', sessionSkills)
    expect(filtered.map((item) => item.name)).toEqual(['cmd-150'])
  })

  it('preserves known skill completion for unclassified session members only', () => {
    const commands = sessionSlashCommandSuggestions('claude', [
      { name: 'clear', kind: 'command', kindUnspecified: true },
      { name: 'typescript', kind: 'command', kindUnspecified: true },
      { name: 'project-check', kind: 'command', kindUnspecified: true }
    ])
    const diskSkills = [
      skill({ description: 'TypeScript skill' }),
      skill({ name: 'not-loaded', skillFilePath: '/not-loaded/SKILL.md' })
    ]
    const items = buildNativeChatPickerItems(commands, diskSkills, '', '/', [])
    expect(items.map(({ name, kind }) => ({ name, kind }))).toEqual([
      { name: 'clear', kind: 'command' },
      { name: 'project-check', kind: 'command' },
      { name: 'typescript', kind: 'skill' }
    ])
    expect(items[2]).toMatchObject({
      description: 'TypeScript skill',
      sources: [{ sourceKind: 'repo' }]
    })
    const classified = sessionSlashCommandSuggestions('claude', [
      { name: 'typescript', kind: 'command' }
    ])
    expect(
      buildNativeChatPickerItems(classified, diskSkills, '', '/', []).map(({ kind }) => kind)
    ).toEqual(['command'])
  })
})
