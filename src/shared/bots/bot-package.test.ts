import { describe, expect, it } from 'vitest'
import { parseBotPackage } from './bot-package'

function sharedAvatar(avatar: Record<string, unknown>) {
  const { bot, droppedKeys } = parseBotPackage({
    schemaVersion: 1,
    name: 'Release notes',
    avatar,
    purpose: 'Drafts release notes.',
    agentHint: 'claude',
    skills: [],
    tools: [],
    connectors: [],
    schedules: [],
    eventSuggestions: [],
    memory: []
  })
  return { avatar: bot.avatar, droppedKeys }
}

describe('a shared mascot look', () => {
  it("reads the sharer's tile color and outfit", () => {
    expect(sharedAvatar({ mascot: 'H1', color: '#f4c4cf', outfit: 'tie' })).toEqual({
      avatar: { mascot: 'H1', color: '#f4c4cf', outfit: 'tie' },
      droppedKeys: []
    })
  })

  it('opens a package from a sharer without colors or outfits', () => {
    expect(sharedAvatar({ mascot: 'H1' })).toEqual({
      avatar: { mascot: 'H1' },
      droppedKeys: []
    })
  })

  it('drops a color it cannot read and lists a field it does not know, as an older importer does', () => {
    expect(sharedAvatar({ mascot: 'H1', color: 'pink', sparkle: true })).toEqual({
      avatar: { mascot: 'H1' },
      droppedKeys: ['avatar.sparkle']
    })
  })
})
