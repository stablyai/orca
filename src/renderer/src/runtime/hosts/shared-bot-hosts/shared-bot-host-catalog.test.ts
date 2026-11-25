import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  SharedBotHostsState,
  SharedBotHostView
} from '../../../../../shared/bots/shared-bot-hosts'
import { callRuntimeRpc } from '../../rpc/calls/runtime-rpc-call'
import { subscribeRuntimeRpc } from '../../rpc/subscriptions/runtime-rpc-subscribe'
import { createCompatibleRuntimeStatusResponseIfNeeded } from '../../rpc/testing/runtime-compatibility-test-fixture'
import {
  installSharedBotHostCatalog,
  readSharedBotHosts,
  readTeamSharingOffered
} from './shared-bot-host-catalog'

const HOST: SharedBotHostView = {
  environmentId: 'shared-env',
  shareId: 'share-1',
  botId: 'bot-1',
  botName: 'Ivy',
  ownerName: 'Jinwoo Hong',
  homeWorkspaceId: 'home-1',
  link: 'live',
  holds: true,
  held: []
}
const target = { kind: 'environment', environmentId: HOST.environmentId } as const

let uninstall: () => void
const environmentCall = vi.fn()
const environmentSubscribe = vi.fn()
let changed: (state: SharedBotHostsState) => void = () => {}

beforeEach(async () => {
  environmentCall.mockReset()
  environmentSubscribe.mockReset().mockResolvedValue({ unsubscribe: () => {} })
  vi.stubGlobal('window', {
    api: {
      sharedBotHosts: {
        list: async () => ({ hosts: [HOST], sharing: true }),
        onChanged: (listener: typeof changed) => {
          changed = listener
          return () => {}
        }
      },
      runtimeEnvironments: { call: environmentCall, subscribe: environmentSubscribe }
    }
  })
  uninstall = installSharedBotHostCatalog()
  await Promise.resolve()
})

afterEach(() => {
  uninstall()
  vi.unstubAllGlobals()
})

// Its calls and streams go through runtimeEnvironments; main routes them (runtime-environment-shared-hosts.test.ts).
describe('a shared agent’s host in the window', () => {
  it('sends calls and streams through runtimeEnvironments, with no channel of its own', async () => {
    environmentCall.mockImplementation(
      async (request: { method: string }) =>
        createCompatibleRuntimeStatusResponseIfNeeded(request) ?? {
          id: 'x',
          ok: true,
          result: {},
          _meta: { runtimeId: 'r' }
        }
    )
    await callRuntimeRpc(target, 'bots.list', {})
    await subscribeRuntimeRpc(
      target,
      'agentSession.subscribe',
      { sessionId: 's' },
      { onEvent: () => {}, onError: () => {}, onClose: () => {} }
    )
    expect(environmentCall).toHaveBeenCalledWith(
      expect.objectContaining({ selector: HOST.environmentId, method: 'bots.list' })
    )
    expect(environmentSubscribe).toHaveBeenCalledWith(
      expect.objectContaining({ selector: HOST.environmentId, method: 'agentSession.subscribe' }),
      expect.any(Object)
    )
  })
})

describe('sharing offered only where the account’s Orca Cloud takes shares', () => {
  it('offers it on a shares answer, and hides every shared agent and offer on an older cloud', () => {
    expect(readTeamSharingOffered()).toBe(true)
    expect(readSharedBotHosts()).toEqual([HOST])
    changed({ hosts: [HOST], sharing: false })
    expect(readTeamSharingOffered()).toBe(false)
    expect(readSharedBotHosts()).toEqual([])
    // Before the cloud first answers, kept shares still list, but nothing new is offered.
    changed({ hosts: [HOST], sharing: null })
    expect(readTeamSharingOffered()).toBe(false)
    expect(readSharedBotHosts()).toEqual([HOST])
  })
})
