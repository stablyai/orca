import { describe, expect, it } from 'vitest'
import type { Bot } from '../../../../../shared/bot-types'
import {
  getSettingsNavGroupDefinitionsForSearch,
  getSettingsSectionId
} from '@/components/settings/navigation/settings-navigation-foundations'
import { matchesSettingsSearch } from '@/components/settings/search/settings-search'
import { isSettingsNavigationTarget } from '@/components/settings/navigation/settings-navigation-types'
import { buildSettingsNavigationMetadata } from './useSettingsNavigationMetadata'

function bot(id: string, name: string): Bot {
  return {
    id,
    name,
    hostId: 'local',
    folder: id,
    folderWorkspaceId: `f-${id}`,
    agent: id === 'b2' ? 'codex' : 'claude',
    avatar: null,
    paused: false,
    permissionMode: 'ask',
    notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
    members: [],
    slack: null,
    chatSessionId: null,
    linear: null,
    github: null,
    createdAt: 1,
    updatedAt: 1
  }
}

const BOTS = [bot('b1', 'Reviewer'), bot('b2', 'Scout')]

describe('bots settings navigation', () => {
  it("finds a bot's page by search and keeps it in the Bots group", () => {
    const sections = buildSettingsNavigationMetadata({
      isMac: true,
      isWindows: false,
      isWebClient: false,
      repos: [],
      bots: BOTS
    })
    const found = sections.filter((section) =>
      matchesSettingsSearch('Scout', section.searchEntries)
    )

    expect(found.map((section) => section.id)).toEqual(['bot-b2'])
    expect(
      getSettingsNavGroupDefinitionsForSearch(found, 'Scout').map((group) => group.id)
    ).toEqual(['bots'])
  })

  it('keeps only the Bots page, which holds the switch, while bots are turned off', () => {
    const sections = buildSettingsNavigationMetadata({
      isMac: true,
      isWindows: false,
      isWebClient: false,
      botsEnabled: false,
      repos: [],
      bots: BOTS
    })
    expect(sections.some((section) => section.id === 'bots')).toBe(true)
    expect(sections.some((section) => section.group === 'bots')).toBe(false)
  })

  it('shows no bots to a web client', () => {
    const sections = buildSettingsNavigationMetadata({
      isMac: true,
      isWindows: false,
      isWebClient: true,
      botsEnabled: true,
      repos: [],
      bots: BOTS
    })
    expect(sections.some((section) => section.id === 'bots' || section.group === 'bots')).toBe(
      false
    )
  })

  it('deep-links to one bot’s page', () => {
    // The sidebar's "Bot settings…" names the bot in sectionId.
    expect(isSettingsNavigationTarget({ pane: 'bots', repoId: null, sectionId: 'b2' })).toBe(true)
    expect(getSettingsSectionId('bots', null, new Map(), 'b2')).toBe('bot-b2')
    expect(getSettingsSectionId('bots', null, new Map())).toBe('bots')
  })
})
