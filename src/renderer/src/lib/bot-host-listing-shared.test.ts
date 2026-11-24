import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Bot } from '../../../shared/bot-types'
import type { SharedBotHostView } from '../../../shared/bots/shared-bot-hosts'
import {
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId
} from '../../../shared/execution-host/execution-host'
import { installSharedBotHostCatalog } from '@/runtime/hosts/shared-bot-hosts/shared-bot-host-catalog'
import { publishBots, readHostBots } from './bot-catalog-snapshot'
import { installBotHostListing } from './bot-host-listing'
import { withSharedBotHomes } from './bot-host-kept-homes'

const SHARED: SharedBotHostView = {
  environmentId: 'shared-env',
  shareId: 'share-1',
  botId: 'bot-1',
  botName: 'Ivy',
  ownerName: 'Jinwoo Hong',
  link: 'live'
}
const HOST = toRuntimeExecutionHostId(SHARED.environmentId)
const KEY = `orca.bots.pairedHostList.v2:${HOST}`

const ivy: Bot = {
  id: 'bot-1',
  name: 'Ivy',
  hostId: LOCAL_EXECUTION_HOST_ID,
  folder: 'ivy',
  folderWorkspaceId: 'fw-ivy',
  agent: 'claude',
  avatar: null,
  paused: false,
  notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
  members: [],
  slack: null,
  linear: null,
  github: null,
  chatSessionId: null,
  createdAt: 1,
  updatedAt: 1
}

const store = {
  getState: () => ({
    runtimeEnvironments: [],
    runtimeEnvironmentCatalogHydrated: true,
    folderWorkspaces: [],
    runtimeStatusByEnvironmentId: new Map()
  }),
  subscribe: () => () => {}
}

let answerList: (views: SharedBotHostView[]) => void = () => {}
const stops: (() => void)[] = []

beforeEach(() => {
  const saved = new Map<string, string>()
  const events = new EventTarget()
  vi.stubGlobal('localStorage', {
    get length() {
      return saved.size
    },
    key: (index: number) => [...saved.keys()][index] ?? null,
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => saved.set(key, value),
    removeItem: (key: string) => saved.delete(key)
  })
  // A teammate's earlier session kept Ivy's list while its owner's computer was away.
  saved.set(
    KEY,
    JSON.stringify({
      pairing: 'share|share-1',
      bots: [ivy],
      threadReplies: false,
      connectorNeedsSignIn: false
    })
  )
  vi.stubGlobal('window', {
    addEventListener: events.addEventListener.bind(events),
    dispatchEvent: events.dispatchEvent.bind(events),
    api: {
      sharedBotHosts: {
        list: () =>
          new Promise<SharedBotHostView[]>((resolve) => {
            answerList = resolve
          }),
        onChanged: () => () => {}
      }
    }
  })
})

afterEach(() => {
  stops.splice(0).forEach((stop) => stop())
  vi.unstubAllGlobals()
})

describe('a shared agent’s listing in the window', () => {
  it('keeps a shared agent’s kept list until main says which agents are shared', async () => {
    stops.push(installSharedBotHostCatalog())
    stops.push(installBotHostListing(store, false))
    expect(localStorage.getItem(KEY)).not.toBeNull()
    answerList([SHARED])
    await Promise.resolve()
    await Promise.resolve()
    expect(localStorage.getItem(KEY)).not.toBeNull()
    answerList = () => {}
  })

  it('has its home from the agent as soon as its host first lists it', async () => {
    localStorage.removeItem(KEY)
    stops.push(installSharedBotHostCatalog())
    answerList([SHARED])
    await Promise.resolve()
    stops.push(installBotHostListing(store, false))
    publishBots([ivy], { threadReplies: false, webhooks: undefined }, HOST)
    expect(readHostBots(HOST).map((bot) => bot.id)).toEqual(['bot-1'])
    const listed = readHostBots(HOST)
    expect(
      withSharedBotHomes([], listed, new Set([HOST])).map((home) => [home.id, home.name])
    ).toEqual([['fw-ivy', 'Ivy']])
  })
})
