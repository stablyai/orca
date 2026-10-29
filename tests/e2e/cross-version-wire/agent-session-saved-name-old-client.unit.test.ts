import { expect, it, vi } from 'vitest'
import { materializeReleaseCheckout, importReleaseCheckoutModule } from './release-checkout'
import { RpcDispatcher } from '../../../src/main/runtime/rpc/dispatcher'
import { AI_VAULT_METHODS } from '../../../src/main/runtime/rpc/methods/ai-vault'
import { SESSION_TAB_METHODS } from '../../../src/main/runtime/rpc/methods/session-tabs'
import { listResult } from '../../../src/main/ai-vault/structured-session-ownership.test-support'
import {
  HOST_TEST_SESSION,
  HOST_TEST_LOCATION
} from '../../../src/main/native-chat/agent-session-wire/structured-agent-session-host-test-data'
import {
  WORKTREE,
  createChat,
  send,
  runtime,
  host,
  store
} from '../../../src/main/runtime/rpc/methods/structured-chat-tab-table.test-fixture'

// Cold CI may materialize the pinned release checkout before importing its client modules.
it('a released client reads the current saved name from tabs and each fresh History query', async () => {
  const checkout = await materializeReleaseCheckout('v1.4.222')
  const [tabs, history, protocol] = await Promise.all(
    [
      'mobile/src/session/mobile-session-read-operations.ts',
      'mobile/src/agent-history/mobile-agent-history-operations.ts',
      'mobile/src/transport/mobile-runtime-client-capabilities.ts'
    ].map((path) => importReleaseCheckoutModule(checkout, path))
  )
  const capabilities = protocol.MOBILE_RUNTIME_CLIENT_CAPABILITIES
  if (
    !Array.isArray(capabilities) ||
    !capabilities.every((value: unknown): value is string => typeof value === 'string')
  ) {
    throw new Error('Pinned released client capabilities missing')
  }
  expect(checkout.commit).toBe('4bb6f2072b07c1f0664b809551f77754700570e4')
  // The fixture already installed the real host on its throwaway SQLite store.
  vi.spyOn(runtime, 'ensureStructuredAgentSessionHost').mockResolvedValue()
  expect(await createChat(HOST_TEST_SESSION)).toMatchObject({ ok: true })
  expect(await send(HOST_TEST_SESSION, 'Begin the compatibility conversation')).toMatchObject({
    ok: true
  })
  const providerId = store.getRecord(HOST_TEST_SESSION)?.providerHandleChain.at(-1)?.handle.nativeId
  if (!providerId) {
    throw new Error('Real host did not acquire provider identity')
  }
  const raw = listResult()
  raw.sessions = [
    {
      ...raw.sessions[0]!,
      id: `local:codex:${providerId}`,
      sessionId: providerId,
      filePath: `/sessions/rollout-${providerId}.jsonl`,
      resumeCommand: `codex resume '${providerId}'`,
      title: 'Provider title'
    }
  ]
  const scan = vi.spyOn(runtime, 'listAiVaultSessions').mockResolvedValue(raw)
  const dispatcher = new RpcDispatcher({
    runtime,
    methods: [...SESSION_TAB_METHODS, ...AI_VAULT_METHODS]
  })
  const client = {
    sendRequest: async (method: string, params: unknown) =>
      JSON.parse(
        JSON.stringify(
          await dispatcher.dispatch(
            { id: method, authToken: 'token', method, params },
            {
              clientKind: 'mobile',
              clientCapabilities: capabilities
            }
          )
        )
      )
  }
  const read = async (operation: unknown, params: unknown): Promise<unknown> => {
    if (
      !operation ||
      typeof operation !== 'object' ||
      !('request' in operation) ||
      typeof operation.request !== 'function' ||
      !('interpret' in operation) ||
      typeof operation.interpret !== 'function'
    ) {
      throw new Error('Released reader missing')
    }
    return operation.interpret(await operation.request(client, params))
  }
  for (const name of ['Cold saved name', 'Renamed on serving host']) {
    expect(await store.setUserConversationName(HOST_TEST_SESSION, name, 'rename')).toMatchObject({
      applied: true
    })
    host.publishConversationName(HOST_TEST_SESSION)
    expect(await read(tabs.sessionTabsListRead, { worktree: WORKTREE })).toMatchObject({
      tabs: [
        expect.objectContaining({
          type: 'agent-session',
          sessionId: HOST_TEST_SESSION,
          title: name
        })
      ]
    })
    expect(await read(history.agentHistorySessionScan, { scopePaths: ['/repo'] })).toMatchObject({
      sessions: [
        expect.objectContaining({
          title: name,
          sessionId: providerId,
          structuredSession: {
            sessionId: HOST_TEST_SESSION,
            workspaceId: HOST_TEST_LOCATION.workspaceId
          }
        })
      ]
    })
  }
  expect(scan).toHaveBeenCalledTimes(2)
  expect(raw.sessions[0]?.title).toBe('Provider title')
  expect(store.getRecord(HOST_TEST_SESSION)).toMatchObject({
    conversationName: 'Renamed on serving host',
    conversationNameSource: 'user'
  })
}, 180_000)
