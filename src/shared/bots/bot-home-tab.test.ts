import { describe, expect, it } from 'vitest'
import type { Bot } from '../bot-types'
import type { Tab } from '../workspace-layout/tab-groups/tab-types'
import { selectLocalBotHomeTabs } from './bot-home-tab'

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
