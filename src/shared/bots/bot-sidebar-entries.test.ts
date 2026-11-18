import { describe, expect, it } from 'vitest'
import { buildByIdIndex } from '../collections/first-row-by-id-index'
import { botPreviewFacts } from './bot-collapsed-preview'
import { botGroupStatusOf } from './bot-group-status'
import { botGroupMemberBots, botGroupRowLine, getBotSidebarEntries } from './bot-sidebar-entries'
import { botFoldLiveStatus } from './bot-sidebar-workspaces'
import { structuredAgentSessionStatusPaneKey } from '../agent-session/view/structured-agent-session-tab'

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
  it('mixes groups among bots in one saved order and skips owners whose home is not loaded', () => {
    const entries = getBotSidebarEntries(
      [bot('atlas', 2), bot('nova', 0), bot('unloaded', 1)],
      [{ ...bot('crew', 1), members: [] }],
      [home('atlas-home'), home('nova-home'), home('crew-home')]
    )
    expect(entries.map((entry) => `${entry.kind}:${entry.id}`)).toEqual([
      'bot:nova',
      'group:crew',
      'bot:atlas'
    ])
  })

  it('puts a bot and a group made after the last drag on top, newest first, above the dragged order', () => {
    const entries = getBotSidebarEntries(
      [bot('atlas', 1, 10), bot('nova', 0, 20), bot('fresh', undefined, 30)],
      [{ ...bot('crew', undefined, 40), members: [] }],
      [home('atlas-home'), home('nova-home'), home('fresh-home'), home('crew-home')]
    )
    expect(entries.map((entry) => `${entry.kind}:${entry.id}`)).toEqual([
      'group:crew',
      'bot:fresh',
      'bot:nova',
      'bot:atlas'
    ])
  })
})

describe('group row', () => {
  const members = [
    { botId: 'nova', sessionId: 's-nova' },
    { botId: 'gone', sessionId: 's-gone' }
  ]

  it('names its loaded members, else its newest post with the owner named', () => {
    const loaded = botGroupMemberBots({ members }, [bot('atlas'), bot('nova')])
    expect(loaded.map((entry) => entry.id)).toEqual(['nova'])
    expect(botGroupRowLine({}, loaded, 'You')).toEqual({ text: 'nova', at: null })
    expect(
      botGroupRowLine({ latest: { authorName: null, text: 'hi', at: 3 } }, loaded, 'You')
    ).toEqual({ text: 'You: hi', at: 3 })
  })

  it('resolves indexed members in room order, skipping missing bots and keeping the first duplicate', () => {
    const loaded = botGroupMemberBots(
      {
        members: [
          { botId: 'nova', sessionId: 's-nova' },
          { botId: 'gone', sessionId: 's-gone' },
          { botId: 'atlas', sessionId: 's-atlas' },
          { botId: 'scout', sessionId: 's-scout' },
          { botId: 'docs', sessionId: 's-docs' }
        ]
      },
      buildByIdIndex([
        { id: 'atlas', name: 'First Atlas' },
        { id: 'nova', name: 'Nova' },
        { id: 'atlas', name: 'Duplicate Atlas' },
        { id: 'scout', name: 'Scout' },
        { id: 'docs', name: 'Docs' }
      ])
    )
    expect(loaded).toEqual([
      { id: 'nova', name: 'Nova' },
      { id: 'atlas', name: 'First Atlas' },
      { id: 'scout', name: 'Scout' },
      { id: 'docs', name: 'Docs' }
    ])
  })

  it('reads its dot from its members’ sessions through any reader', () => {
    const blocked = { state: 'blocked' as const, interrupted: false }
    expect(
      botGroupStatusOf({ members }, (paneKey) =>
        paneKey === structuredAgentSessionStatusPaneKey('s-gone') ? blocked : undefined
      )
    ).toBe('permission')
    expect(botGroupStatusOf({ members }, () => undefined)).toBeNull()
    // A thread's members count too, as #472's rollup does.
    const thread = { id: 't-1', createdAt: 1, members: [{ botId: 'nova', sessionId: 's-thread' }] }
    expect(
      botGroupStatusOf({ members: [], threads: [thread] }, (paneKey) =>
        paneKey === structuredAgentSessionStatusPaneKey('s-thread') ? blocked : undefined
      )
    ).toBe('permission')
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
