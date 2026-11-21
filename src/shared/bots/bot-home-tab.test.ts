import { describe, expect, it } from 'vitest'
import type { Bot } from '../bot-types'
import type { Tab } from '../workspace-layout/tab-groups/tab-types'
import { isBotSideChatTab, isHostedBotChatTab, selectLocalBotHomeTabs } from './bot-home-tab'

const bot: Pick<Bot, 'hostId' | 'folderWorkspaceId' | 'chatSessionId'> = {
  hostId: 'local',
  folderWorkspaceId: 'home-folder',
  chatSessionId: 'home'
}

function home(id: string, createdAt: number, isPreview = false): Tab {
  return {
    id,
    entityId: 'home',
    worktreeId: 'folder:home-folder',
    executionHostId: 'local',
    groupId: 'group',
    contentType: 'agent-session',
    label: 'Home',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt,
    isPreview
  }
}

describe('local Home survivor selection', () => {
  const preview = home('preview', 1, true)
  it('keeps the oldest published view with stable id precedence for equal ages', () => {
    const selected = selectLocalBotHomeTabs(
      [home('newer', 3), home('b', 2), home('a', 2), preview],
      bot
    )
    expect(selected?.home.id).toBe('a')
    expect(selected?.duplicates.map((tab) => tab.id)).toEqual(['b', 'newer', 'preview'])
  })

  it('waits when every matching view is still a preview', () => {
    expect(selectLocalBotHomeTabs([preview, home('other-preview', 2, true)], bot)).toBeNull()
  })
})

describe('a chat restored without a host', () => {
  const { executionHostId: _host, ...restored } = home('restored', 1)
  const hostless: Tab = restored
  const local = (): boolean => true

  it("counts as a local bot's Home and side chats once its workspace is vouched local", () => {
    expect(selectLocalBotHomeTabs([hostless], bot, local)?.home.id).toBe('restored')
    expect(isBotSideChatTab({ ...hostless, entityId: 'side' }, bot, local)).toBe(true)
  })

  it('counts for no bot while nothing vouches for its workspace', () => {
    expect(selectLocalBotHomeTabs([hostless], bot)).toBeNull()
    expect(selectLocalBotHomeTabs([hostless], bot, () => false)).toBeNull()
    expect(isHostedBotChatTab(hostless, bot)).toBe(false)
  })

  it("never counts as a paired or SSH bot's chat", () => {
    for (const hostId of ['runtime:env-1', 'ssh:box'] as const) {
      const remoteBot = { ...bot, hostId }
      expect(isHostedBotChatTab(hostless, remoteBot, local)).toBe(false)
      expect(isHostedBotChatTab({ ...hostless, executionHostId: hostId }, remoteBot)).toBe(true)
      expect(isHostedBotChatTab({ ...hostless, executionHostId: hostId }, bot, local)).toBe(false)
    }
  })
})
