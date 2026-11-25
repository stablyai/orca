import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  SharedBotHostsState,
  SharedBotHostView
} from '../../../../../shared/bots/shared-bot-hosts'
import { callRuntimeRpc } from '../../rpc/calls/runtime-rpc-call'
import { subscribeRuntimeRpc } from '../../rpc/subscriptions/runtime-rpc-subscribe'
import { ensureRuntimeEnvironmentCompatible } from '../../rpc/compatibility/runtime-compatibility-probe'
import { runtimeEnvironmentSupportsCapability } from '../../rpc/compatibility/runtime-capability-proof'
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
const call = vi.fn()
const subscribe = vi.fn()
const environmentCall = vi.fn()
let changed: (state: SharedBotHostsState) => void = () => {}

beforeEach(async () => {
  call.mockReset().mockResolvedValue({ id: 'x', ok: true, result: {}, _meta: { runtimeId: 'r' } })
  subscribe.mockReset().mockResolvedValue({ unsubscribe: () => {} })
  environmentCall.mockReset()
  vi.stubGlobal('window', {
    api: {
      sharedBotHosts: {
        list: async () => ({ hosts: [HOST], sharing: true }),
        onChanged: (listener: typeof changed) => {
          changed = listener
          return () => {}
        },
        call,
        subscribe
      },
      runtimeEnvironments: { call: environmentCall }
    }
  })
  uninstall = installSharedBotHostCatalog()
  await Promise.resolve()
})

afterEach(() => {
  uninstall()
  vi.unstubAllGlobals()
})

describe('what a teammate’s Orca asks a shared agent’s host', () => {
  it('never sends a read the share refuses, and answers it as the host would', async () => {
    for (const method of ['bots.activity', 'bots.upNext.unseen', 'pairedServerAsks.list']) {
      await expect(callRuntimeRpc(target, method, { botId: 'bot-1' })).rejects.toMatchObject({
        code: 'method_not_found'
      })
    }
    const onError = vi.fn()
    await subscribeRuntimeRpc(
      target,
      'bots.items.subscribe',
      {},
      {
        onEvent: () => {},
        onError,
        onClose: () => {}
      }
    )
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'method_not_found' }))
    expect(call).not.toHaveBeenCalled()
    expect(subscribe).not.toHaveBeenCalled()
  })

  it('sends what the share allows over its own link', async () => {
    await callRuntimeRpc(target, 'bots.list', {})
    await subscribeRuntimeRpc(
      target,
      'agentSession.subscribe',
      { sessionId: 's' },
      {
        onEvent: () => {},
        onError: () => {},
        onClose: () => {}
      }
    )
    expect(call).toHaveBeenCalledWith(expect.objectContaining({ method: 'bots.list' }))
    expect(subscribe).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'agentSession.subscribe' }),
      expect.any(Function)
    )
  })

  it('probes no status: the host answers none to a share', async () => {
    await expect(ensureRuntimeEnvironmentCompatible(HOST.environmentId)).resolves.toBeNull()
    // A capability read refuses as the host would; the paired-server registry is never asked.
    await expect(
      runtimeEnvironmentSupportsCapability(HOST.environmentId, 'agent-session.rewind')
    ).rejects.toMatchObject({ code: 'method_not_found' })
    expect(environmentCall).not.toHaveBeenCalled()
    expect(call).not.toHaveBeenCalled()
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
