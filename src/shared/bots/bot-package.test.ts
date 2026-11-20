import { describe, expect, it } from 'vitest'
import { parseBotPackage, planBotFromPackage } from './bot-package'

function sharedBot(avatar: Record<string, unknown>): Record<string, unknown> {
  return {
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
  }
}

function plan(avatar: Record<string, unknown>) {
  const { bot, droppedKeys } = parseBotPackage(sharedBot(avatar))
  return {
    create: planBotFromPackage(bot, [], { agent: 'claude', toolIds: [] }).create,
    droppedKeys
  }
}

describe('a shared mascot look', () => {
  it("carries the sharer's tile color and outfit to the new bot", () => {
    expect(plan({ mascot: 'H1', color: '#f4c4cf', outfit: 'tie' })).toEqual({
      create: {
        name: 'Release notes',
        agent: 'claude',
        avatar: 'mascot:H1',
        avatarColor: '#f4c4cf',
        avatarOutfit: 'tie'
      },
      droppedKeys: []
    })
  })

  it('opens a package from a sharer without colors or outfits on the plain mascot', () => {
    expect(plan({ mascot: 'H1' })).toEqual({
      create: { name: 'Release notes', agent: 'claude', avatar: 'mascot:H1' },
      droppedKeys: []
    })
  })

  it("leaves off an outfit this version doesn't know and a field it doesn't read", () => {
    // A newer sharer's extras, as an older importer meets color and outfit: dropped and listed.
    expect(plan({ mascot: 'H1', outfit: 'aviator', sparkle: true })).toEqual({
      create: { name: 'Release notes', agent: 'claude', avatar: 'mascot:H1' },
      droppedKeys: ['avatar.sparkle']
    })
  })
})
