import { describe, expect, it } from 'vitest'
import type { Tab } from '../../../../shared/workspace-layout/tab-groups/tab-types'
import type { Bot } from '../../../../shared/bot-types'
import type { ExecutionHostId } from '../../../../shared/execution-host/execution-host'
import { stampBotHost } from '@/lib/bot-catalog-snapshot'
import { displayedTabOrder, homeBotLookupFor } from './bot-home-tab-order'
import { storedIndexForDisplayedDrop } from '../tab-group/drag/tab-drop-displayed-order'

function chatTab(id: string, entityId: string): Tab {
  return {
    id,
    entityId,
    groupId: 'group',
    worktreeId: 'folder:bot-home',
    contentType: 'agent-session',
    label: id,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

const onBotPage = (): { chatSessionId: string } => ({ chatSessionId: 'home-chat' })
const tabs = [chatTab('a', 'a-chat'), chatTab('b', 'b-chat'), chatTab('home', 'home-chat')]

describe('displayedTabOrder', () => {
  it('leads with a Home the stored order misses, as the bar draws it', () => {
    expect(displayedTabOrder(['a', 'b'], tabs, 'folder:bot-home', onBotPage)).toEqual([
      'home',
      'a',
      'b'
    ])
  })

  it('lands a tab from another group dropped after that Home before the first tab drawn after it', () => {
    const displayed = displayedTabOrder(['a', 'b'], tabs, 'folder:bot-home', onBotPage)
    expect(storedIndexForDisplayedDrop(['a', 'b'], displayed, 'home', 'right')).toBe(0)
  })

  it('moves a stored Home first, and appends unlisted tabs in place off a bot page', () => {
    expect(displayedTabOrder(['a', 'home', 'b'], tabs, 'folder:bot-home', onBotPage)).toEqual([
      'home',
      'a',
      'b'
    ])
    expect(displayedTabOrder(['a', 'b'], tabs, 'folder:bot-home', () => null)).toEqual([
      'a',
      'b',
      'home'
    ])
  })
})

describe('homeBotLookupFor', () => {
  // A host listing stamps its bots with that host, as the catalog does.
  const bot = (id: string, folderWorkspaceId: string, hostId: ExecutionHostId): Bot =>
    stampBotHost(hostId, {
      id,
      name: id,
      hostId: 'local',
      folder: id,
      folderWorkspaceId,
      agent: 'claude',
      avatar: null,
      paused: false,
      notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
      members: [],
      slack: null,
      linear: null,
      github: null,
      chatSessionId: `${id}-chat`,
      createdAt: 0,
      updatedAt: 0
    })

  it('has no lookup for a strip no bot calls home, so the tab bar skips the Home search', () => {
    expect(homeBotLookupFor([], 'repo-a::/path/worktree')).toBeNull()
    expect(homeBotLookupFor([bot('b1', 'other-home', 'local')], 'folder:bot-home')).toBeNull()
  })

  it("asks each tab's own host on a bot's home, even when the bot lives on another host", () => {
    const remote = bot('b1', 'bot-home', 'runtime:other')
    const lookup = homeBotLookupFor([remote], 'folder:bot-home')
    expect(lookup?.('runtime:other')).toBe(remote)
    expect(lookup?.('local')).toBeNull()
  })

  it('keeps each host to its own bot when two hosts share a home id', () => {
    const local = bot('b1', 'bot-home', 'local')
    const remote = bot('b2', 'bot-home', 'runtime:other')
    const lookup = homeBotLookupFor([local, remote], 'folder:bot-home')
    expect(lookup?.('local')).toBe(local)
    expect(lookup?.('runtime:other')).toBe(remote)
  })
})
