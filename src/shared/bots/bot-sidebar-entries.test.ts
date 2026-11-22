import { describe, expect, it } from 'vitest'
import { buildByIdIndex } from '../collections/first-row-by-id-index'
import { botPreviewFacts } from './bot-collapsed-preview'
import { botGroupMemberBots, botGroupRowLine, getBotSidebarEntries } from './bot-sidebar-entries'
import { botFoldLiveStatus } from './bot-sidebar-workspaces'

const home = (id: string) => ({ id, executionHostId: 'local' as const })
const bot = (id: string, sidebarOrder?: number, createdAt = 1) => ({
  id,
  name: id,
  hostId: 'local' as const,
  folderWorkspaceId: `${id}-home`,
  createdAt,
  sidebarOrder
})

describe('getBotSidebarEntries', () => {
  it('mixes saved bots and groups below new ones and omits owners without homes', () => {
    const entries = getBotSidebarEntries(
      [bot('atlas', 2, 10), bot('nova', 0, 20), bot('fresh', undefined, 30), bot('unloaded', 3)],
      [
        { ...bot('crew', undefined, 40), members: [] },
        { ...bot('saved', 1, 5), members: [] }
      ],
      [
        home('atlas-home'),
        home('nova-home'),
        home('fresh-home'),
        home('crew-home'),
        home('saved-home')
      ]
    )
    expect(entries.map((entry) => `${entry.kind}:${entry.id}`)).toEqual([
      'group:crew',
      'bot:fresh',
      'bot:nova',
      'group:saved',
      'bot:atlas'
    ])
  })
})

describe('group row', () => {
  const members = [
    { botId: 'nova', sessionId: 's-nova' },
    { botId: 'gone', sessionId: 's-gone' }
  ]

  it('names the loaded members in room order or shows the latest post', () => {
    const group = {
      members: [
        ...members,
        { botId: 'atlas', sessionId: 's-atlas' },
        { botId: 'scout', sessionId: 's-scout' }
      ]
    }
    const bots = [
      { id: 'atlas', name: 'First Atlas' },
      { id: 'nova', name: 'Nova' },
      { id: 'atlas', name: 'Duplicate Atlas' },
      { id: 'scout', name: 'Scout' }
    ]
    const loaded = botGroupMemberBots(group, buildByIdIndex(bots))
    expect(loaded).toEqual([
      { id: 'nova', name: 'Nova' },
      { id: 'atlas', name: 'First Atlas' },
      { id: 'scout', name: 'Scout' }
    ])
    expect(botGroupMemberBots(group, bots)).toEqual(loaded)
    expect(botGroupRowLine({}, loaded, 'You')).toEqual({
      text: 'Nova, First Atlas, Scout',
      at: null
    })
    expect(
      botGroupRowLine({ latest: { authorName: null, text: 'hi', at: 3 } }, loaded, 'You')
    ).toEqual({ text: 'You: hi', at: 3 })
  })
})

describe('bot row facts', () => {
  it('rolls its workspaces into the folded face, with only its home’s unread', () => {
    expect(
      botPreviewFacts({ own: 'active', workspaces: ['failed'], homeUnread: false, paused: false })
    ).toEqual({ status: 'active', attention: true, unread: false, paused: false })
  })

  it('shows a folded row its most urgent live workspace', () => {
    expect(botFoldLiveStatus({ permission: 0, working: 2, failed: 1 })).toBe('working')
    expect(botFoldLiveStatus({ permission: 0, working: 0, failed: 0 })).toBeNull()
  })
})
