import { describe, expect, it } from 'vitest'
import { buildNativeChatPickerItems } from './native-chat-picker-items'
import type { DiscoveredSkill } from './skills'

function discoveredSkill(fields: Partial<DiscoveredSkill>): DiscoveredSkill {
  return {
    id: 'claude:quiver:catchup',
    name: 'catchup',
    description: 'Catch up',
    providers: ['claude'],
    sourceKind: 'plugin',
    sourceLabel: 'Claude plugin quiver',
    rootPath: '/plugins/quiver/skills',
    directoryPath: '/plugins/quiver/skills/catchup',
    skillFilePath: '/plugins/quiver/skills/catchup/SKILL.md',
    installed: true,
    updatedAt: null,
    ...fields
  }
}

describe('buildNativeChatPickerItems plugin namespacing', () => {
  it('inserts a plugin skill under its plugin:skill invocation name', () => {
    const items = buildNativeChatPickerItems([], [discoveredSkill({})], '', '/')
    expect(items).toEqual([
      {
        kind: 'skill',
        id: 'skill:quiver:catchup',
        name: 'quiver:catchup',
        token: '/quiver:catchup',
        description: 'Catch up',
        sources: [
          { sourceKind: 'plugin', skillFilePath: '/plugins/quiver/skills/catchup/SKILL.md' }
        ]
      }
    ])
  })

  it('keeps a plugin skill and a same-named home skill as two rows', () => {
    const items = buildNativeChatPickerItems(
      [],
      [
        discoveredSkill({}),
        discoveredSkill({
          id: 'claude:catchup',
          sourceKind: 'home',
          sourceLabel: 'Home',
          rootPath: '/home/u/.claude/skills',
          directoryPath: '/home/u/.claude/skills/catchup',
          skillFilePath: '/home/u/.claude/skills/catchup/SKILL.md'
        })
      ],
      '',
      '/'
    )
    // Scope priority orders the home row before the plugin row.
    expect(items.map((item) => item.name)).toEqual(['catchup', 'quiver:catchup'])
  })

  it('aligns a session-reported plugin skill with its namespaced discovered row', () => {
    const bare = discoveredSkill({ description: null })
    const items = buildNativeChatPickerItems([], [bare], '', '/', [
      { name: 'quiver:catchup', description: 'Reported description' }
    ])
    // The report is the authority that the namespaced skill exists; the scan
    // supplies the file it lives in, and the report's description fills a bare row.
    expect(items).toEqual([
      {
        kind: 'skill',
        id: 'skill:quiver:catchup',
        name: 'quiver:catchup',
        token: '/quiver:catchup',
        description: 'Reported description',
        sources: [
          { sourceKind: 'plugin', skillFilePath: '/plugins/quiver/skills/catchup/SKILL.md' }
        ]
      }
    ])
  })
})
