import { describe, expect, it } from 'vitest'
import type { Bot } from '../../../../../shared/bot-types'
import type { Repo } from '../../../../../shared/repository/repo-types'
import {
  getSettingsNavGroupDefinitionsForSearch,
  getSettingsSectionId,
  SETTINGS_NAV_GROUPS
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
  it('lists the Bots page under Set Up and one page per bot in the Bots group', () => {
    const sections = buildSettingsNavigationMetadata({
      isMac: true,
      isWindows: false,
      isWebClient: false,
      repos: [],
      bots: BOTS
    })
    expect(sections.find((section) => section.id === 'bots')?.group).toBe('setup')
    expect(
      sections
        .filter((section) => section.group === 'bots')
        .map((section) => [section.id, section.title])
    ).toEqual([
      ['bot-b1', 'Reviewer'],
      ['bot-b2', 'Scout']
    ])
  })

  it('puts the bots directly above Projects, as the sidebar does, with their avatars', () => {
    const repo = {
      id: 'repo-1',
      path: '/repo',
      displayName: 'Repo',
      badgeColor: '#000',
      addedAt: 0
    } satisfies Repo
    const sections = buildSettingsNavigationMetadata({
      isMac: true,
      isWindows: false,
      isWebClient: false,
      repos: [repo],
      bots: [{ ...BOTS[0], avatar: '🦉' }, BOTS[1]]
    })
    const firstBot = sections.findIndex((section) => section.group === 'bots')
    const firstProject = sections.findIndex((section) => section.id.startsWith('repo-'))

    expect(SETTINGS_NAV_GROUPS.at(-1)?.id).toBe('bots')
    expect(firstBot).toBeGreaterThan(
      sections.findIndex((section) => section.group === 'experimental')
    )
    expect(firstProject).toBe(firstBot + 2)
    expect(sections.slice(firstBot, firstProject).map((section) => section.bot)).toEqual([
      { ...BOTS[0], avatar: '🦉' },
      BOTS[1]
    ])
  })

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

  it('describes each bot page by its agent, as bots name it', () => {
    const sections = buildSettingsNavigationMetadata({
      isMac: true,
      isWindows: false,
      isWebClient: false,
      repos: [],
      bots: BOTS
    })
    expect(
      sections.filter((section) => section.group === 'bots').map((section) => section.description)
    ).toEqual(['Claude Code', 'Codex'])
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
