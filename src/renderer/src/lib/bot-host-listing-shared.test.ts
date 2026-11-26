import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Bot } from '../../../shared/bot-types'
import type { SharedBotHostsState, SharedBotHostView } from '../../../shared/bots/shared-bot-hosts'
import {
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId
} from '../../../shared/execution-host/execution-host'
import { installSharedBotHostCatalog } from '@/runtime/hosts/shared-bot-hosts/shared-bot-host-catalog'
import { setBotHostListing } from './bot-catalog-snapshot'
import { isBotHostDown, readBotHostDown } from './bot-host-views'
import { computeBotHostListing, installBotHostListing } from './bot-host-listing'

const SHARED: SharedBotHostView = {
  environmentId: 'shared-env',
  shareId: 'share-1',
  botId: 'bot-1',
  botName: 'Ivy',
  ownerName: 'Jinwoo Hong',
  link: 'live',
  holds: true,
  held: []
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

let answerList: (state: SharedBotHostsState) => void = () => {}
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
          new Promise<SharedBotHostsState>((resolve) => {
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
    answerList({ hosts: [SHARED], sharing: true })
    await Promise.resolve()
    await Promise.resolve()
    expect(localStorage.getItem(KEY)).not.toBeNull()
    answerList = () => {}
  })
})

describe('a shared agent just accepted', () => {
  it('is listed as connecting, not offline, until its link is live', () => {
    const state = (view: SharedBotHostView) =>
      computeBotHostListing(
        { ...store.getState(), sharedBotHosts: [view], sharedBotHostsHydrated: true },
        { state: () => null, updateNeeded: [] },
        { webClient: true }
      ).hosts[0]?.state
    expect(state({ ...SHARED, link: 'unpaired', accepting: true })).toBe('connecting')
    expect(state({ ...SHARED, link: 'offline', accepting: false })).toBe('offline')
    expect(state({ ...SHARED, link: 'live', accepting: true })).toBe('live')
  })

  it('is unreachable to every reader while connecting, as while offline', () => {
    const listed = (state: 'live' | 'connecting' | 'offline') => {
      setBotHostListing({
        hosts: [
          { hostId: LOCAL_EXECUTION_HOST_ID, state: 'live' },
          { hostId: HOST, state }
        ],
        updateNeeded: []
      })
      return [readBotHostDown(HOST), isBotHostDown(HOST)]
    }
    try {
      expect(listed('connecting')).toEqual(['connecting', true])
      expect(listed('offline')).toEqual(['offline', true])
      expect(listed('live')).toEqual([null, false])
      expect(isBotHostDown(LOCAL_EXECUTION_HOST_ID)).toBe(false)
    } finally {
      setBotHostListing({
        hosts: [{ hostId: LOCAL_EXECUTION_HOST_ID, state: 'live' }],
        updateNeeded: []
      })
    }
  })
})
