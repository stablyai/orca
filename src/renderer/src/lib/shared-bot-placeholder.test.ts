import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Bot } from '../../../shared/bot-types'
import type { SharedBotHostView } from '../../../shared/bots/shared-bot-hosts'
import { toRuntimeExecutionHostId } from '../../../shared/execution-host/execution-host'
import { publishBots, readBotHostState, readHostBots } from './bot-catalog-snapshot'
import { syncBotHostListing } from './bot-host-listing'

const SHARED: SharedBotHostView = {
  environmentId: 'shared-env',
  shareId: 'share-1',
  botId: 'bot-1',
  botName: 'Ivy',
  ownerName: 'Jinwoo Hong',
  homeWorkspaceId: 'home-1',
  link: 'offline',
  holds: true,
  held: []
}
const HOST = toRuntimeExecutionHostId(SHARED.environmentId)

const listed = (sharedBotHosts: SharedBotHostView[]): void =>
  syncBotHostListing(
    {
      runtimeEnvironments: [],
      runtimeEnvironmentCatalogHydrated: true,
      folderWorkspaces: [],
      runtimeStatusByEnvironmentId: new Map(),
      sharedBotHosts,
      sharedBotHostsHydrated: true
    },
    false
  )

describe('a shared agent found while its computer is away', () => {
  // A host coming back tells every bot view through a window event.
  beforeEach(() => vi.stubGlobal('window', new EventTarget()))
  afterEach(() => vi.unstubAllGlobals())

  it('is listed at once, offline, and the host’s first read replaces it', () => {
    listed([SHARED])
    expect(readBotHostState(HOST)).toBe('offline')
    expect(readHostBots(HOST).map((bot) => [bot.id, bot.name, bot.hostId])).toEqual([
      ['bot-1', 'Ivy', HOST]
    ])
    listed([{ ...SHARED, link: 'live' }])
    const read: Bot = { ...readHostBots(HOST)[0]!, name: 'Ivy (host)', agent: 'codex' }
    publishBots([read], { threadReplies: false, webhooks: undefined }, HOST)
    expect(readHostBots(HOST).map((bot) => [bot.name, bot.agent])).toEqual([
      ['Ivy (host)', 'codex']
    ])
  })
})
