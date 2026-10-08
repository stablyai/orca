import { beforeAll, describe, expect, it } from 'vitest'
import { STRUCTURED_AGENT_SESSION_CLIENT_OPTIONS_RUNTIME_CAPABILITY } from '../../../src/shared/structured-agent-session-surface-capabilities'
import {
  importReleaseCheckoutModule,
  materializeReleaseCheckout,
  resolveBaselineReleaseRef
} from './release-checkout'
import {
  loadAgentSessionWireBuild,
  WORKING_TREE,
  type AgentSessionWireBuild
} from './versioned-agent-session-wire'

const LEGACY_REFS = [
  'v1.4.184',
  'v1.4.190',
  'v1.4.199',
  'v1.4.205',
  'v1.4.211',
  'v1.4.212',
  'v1.4.214',
  'v1.4.218',
  'v1.4.219',
  'v1.4.220'
]
const PRE_CHAT_REFS = new Set(['v1.4.184', 'v1.4.190'])
const SUITE_TIMEOUT_MS = 180_000
let host: AgentSessionWireBuild

beforeAll(async () => {
  host = await loadAgentSessionWireBuild(WORKING_TREE)
}, SUITE_TIMEOUT_MS)

function callable(module: Record<string, unknown>, name: string) {
  const value = module[name]
  if (typeof value !== 'function') {
    throw new Error(`The released client exports no ${name}`)
  }
  return value
}

async function createSupportReply(clientKind: 'runtime' | 'mobile'): Promise<unknown> {
  const replies: unknown[] = []
  await host
    .createDispatcher({
      getRuntimeId: () => 'runtime-1',
      getClientSettings: () => ({ experimentalStructuredNativeChat: true }),
      getStructuredAgentSessionCreateSupport: async () => ({ supported: true }),
      structuredAgentSessionLaunchSeedOptions: () => undefined
    })
    .dispatchStreaming(
      {
        id: 'create-support',
        authToken: 'cross-version-token',
        method: 'agentSession.createSupport',
        params: { worktree: 'id:wt-1', agent: 'claude' }
      },
      (raw) => replies.push(JSON.parse(raw)),
      { clientKind, clientCapabilities: host.capabilities }
    )
  expect(replies).toHaveLength(1)
  expect(replies[0]).toMatchObject({
    ok: true,
    result: { supported: true, acceptsClientOptions: true }
  })
  return replies[0]
}

describe('released clients reading new-chat option support', () => {
  it.each(LEGACY_REFS)(
    '%s accepts the additive host reply on desktop and phone',
    async (ref) => {
      const checkout = await materializeReleaseCheckout(ref)
      const [desktop, phone] = await Promise.all([
        importReleaseCheckoutModule(checkout, 'src/renderer/src/runtime/runtime-rpc-result.ts'),
        importReleaseCheckoutModule(checkout, 'mobile/src/transport/rpc-response-shape.ts')
      ])
      const desktopReply = await createSupportReply('runtime')
      expect(callable(desktop, 'unwrapRuntimeRpcResult')(desktopReply)).toEqual({
        supported: true,
        acceptsClientOptions: true
      })
      const phoneReply = await createSupportReply('mobile')
      expect(callable(phone, 'isRpcResponse')(phoneReply)).toBe(true)
      if (!PRE_CHAT_REFS.has(ref)) {
        await expectPhoneChatCreate(checkout, phoneReply)
      }
    },
    SUITE_TIMEOUT_MS
  )

  it(
    'the newest released desktop and phone accept the additive host reply',
    async () => {
      const checkout = await materializeReleaseCheckout(resolveBaselineReleaseRef())
      const [desktop, phone] = await Promise.all([
        importReleaseCheckoutModule(checkout, 'src/renderer/src/runtime/runtime-rpc-result.ts'),
        importReleaseCheckoutModule(checkout, 'mobile/src/transport/rpc-response-shape.ts')
      ])
      expect(
        callable(desktop, 'unwrapRuntimeRpcResult')(await createSupportReply('runtime'))
      ).toEqual({
        supported: true,
        acceptsClientOptions: true
      })
      const phoneReply = await createSupportReply('mobile')
      expect(callable(phone, 'isRpcResponse')(phoneReply)).toBe(true)
      await expectPhoneChatCreate(checkout, phoneReply)
    },
    SUITE_TIMEOUT_MS
  )
})

async function expectPhoneChatCreate(
  checkout: Awaited<ReturnType<typeof materializeReleaseCheckout>>,
  supportReply: unknown
): Promise<void> {
  const launch = await importReleaseCheckoutModule(
    checkout,
    'mobile/src/session/mobile-structured-agent-session-launch.ts'
  )
  const protocol = await importReleaseCheckoutModule(checkout, 'src/shared/protocol-version.ts')
  const acceptsClientOptions =
    Array.isArray(protocol.RUNTIME_CAPABILITIES) &&
    protocol.RUNTIME_CAPABILITIES.includes(
      STRUCTURED_AGENT_SESSION_CLIENT_OPTIONS_RUNTIME_CAPABILITY
    )
  const creates: unknown[] = []
  const client = {
    sendRequest: async (method: string, params?: unknown) => {
      if (method === 'agentSession.createSupport') {
        return supportReply
      }
      if (method === 'settings.get') {
        return { id: 'settings', ok: true, result: { nativeChatPermissionMode: 'ask' } }
      }
      if (method !== 'agentSession.create') {
        throw new Error(`Unexpected request: ${method}`)
      }
      creates.push(params)
      return { id: 'create', ok: true, result: { ok: true, value: { sessionId: 'created-chat' } } }
    }
  }
  expect(
    await callable(launch, 'createMobileStructuredAgentSession')(client, 'wt-1', 'claude')
  ).toEqual({
    kind: 'created',
    sessionId: 'created-chat'
  })
  expect(creates).toHaveLength(1)
  if (acceptsClientOptions) {
    expect(creates[0]).toMatchObject({ options: { permissionMode: 'ask' } })
  } else {
    expect(creates[0]).not.toHaveProperty('options')
  }
}
