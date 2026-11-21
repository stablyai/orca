import { describe, expect, it } from 'vitest'
import type { Bot } from '../../../../shared/bot-types'
import type { ExecutionHostId } from '../../../../shared/execution-host/execution-host'
import { findBotByWorkspace, findBotForChatTab } from './bot-workspace'

function hosted(hostId: ExecutionHostId): Bot {
  const bot: Bot = {
    id: hostId,
    name: 'Reviewer',
    hostId: 'local',
    folder: 'reviewer',
    folderWorkspaceId: 'shared-home',
    agent: 'codex',
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
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the catalog stamps a paired server's bots with that host the same way.
  return { ...bot, hostId } as Bot
}

describe('the bot behind a page', () => {
  it("names each host's own bot when two hosts use the same workspace id", () => {
    const bots = [hosted('local'), hosted('runtime:server')]
    expect(findBotByWorkspace(bots, 'folder:shared-home', 'runtime:server')?.id).toBe(
      'runtime:server'
    )
    expect(findBotByWorkspace(bots, 'folder:shared-home', 'local')?.id).toBe('local')
  })

  it("never names another host's bot for a host that has none at that workspace id", () => {
    const bots = [hosted('runtime:server')]
    expect(findBotByWorkspace(bots, 'folder:shared-home', 'local')).toBeNull()
    expect(findBotByWorkspace(bots, 'folder:shared-home')?.id).toBe('runtime:server')
  })

  it('offers a chat saved without a host to the local bot first, whatever the catalog order', () => {
    const bots = [hosted('runtime:server'), hosted('local')]
    expect(findBotForChatTab(bots, 'folder:shared-home', undefined)?.id).toBe('local')
    expect(findBotForChatTab(bots, 'folder:shared-home', 'runtime:server')?.id).toBe(
      'runtime:server'
    )
    expect(findBotForChatTab([hosted('runtime:server')], 'folder:shared-home', undefined)?.id).toBe(
      'runtime:server'
    )
  })
})
