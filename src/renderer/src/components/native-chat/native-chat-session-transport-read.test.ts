import { replaceRuntimeEnvironmentRevisions } from '@/runtime/runtime-environment-revision'
import type * as RuntimeRpcClient from '@/runtime/runtime-rpc-client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import {
  clearRuntimeCompatibilityCacheForTests,
  markRuntimeEnvironmentCompatible
} from '@/runtime/runtime-rpc-client'
import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-result'
import { RUNTIME_COMPAT_BLOCK_CODE } from '@/runtime/runtime-protocol-compat'
import {
  getNativeChatSessionTransport,
  toRuntimeNativeChatErrorMessage
} from './native-chat-session-transport'

const nativeChatReadSession = vi.fn()
const nativeChatSubscribe = vi.fn()
const runtimeEnvironmentsCall = vi.fn()
const runtimeEnvironmentsSubscribe = vi.fn()

const web = vi.hoisted(() => ({ create: vi.fn(), read: vi.fn(), resolve: vi.fn() }))
vi.mock('@/web/preload-api/web-native-chat-api', () => ({ createWebNativeChatApi: web.create }))
vi.mock('@/web/preload-api/web-runtime-session', () => ({
  resolveEnvironment: web.resolve,
  requireActiveEnvironmentOrNull: () => null
}))
const supportsCurrentRequests = vi.hoisted(() => vi.fn())
vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeRpcClient>()),
  runtimeEnvironmentSupportsCapability: supportsCurrentRequests
}))

const ENV = 'env-1'

function message(id: string): NativeChatMessage {
  return {
    id,
    role: 'assistant',
    blocks: [{ type: 'text', text: id }],
    timestamp: 1,
    source: 'transcript'
  }
}

function okEnvelope(result: unknown): { ok: true; result: unknown } {
  return { ok: true, result }
}

/** Let the compatibility-gate await chain reach the runtime bridge. */

beforeEach(() => {
  vi.clearAllMocks()
  replaceRuntimeEnvironmentRevisions([])
  replaceRuntimeEnvironmentRevisions([{ id: ENV, createdAt: 1 }])
  supportsCurrentRequests.mockResolvedValue(false)
  web.create.mockReturnValue({ readSession: web.read })
  web.resolve.mockImplementation((id) => ({ id }))
  web.read.mockResolvedValue({ messages: [] })
  clearRuntimeCompatibilityCacheForTests()
  delete (globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__
  vi.stubGlobal('window', {
    location: { pathname: '/index.html' },
    api: {
      nativeChat: { readSession: nativeChatReadSession, subscribe: nativeChatSubscribe },
      runtimeEnvironments: {
        call: runtimeEnvironmentsCall,
        subscribe: runtimeEnvironmentsSubscribe,
        cancelSubscription: vi.fn(async () => {})
      }
    }
  })
})

describe('getNativeChatSessionTransport — selection', () => {
  it('returns the local adapter for a null owner and forwards readSession args', async () => {
    nativeChatReadSession.mockResolvedValue({ messages: [] })
    const transport = getNativeChatSessionTransport(null)

    await transport.readSession('claude', 'sess-1', 40, '/t/path')

    expect(nativeChatReadSession).toHaveBeenCalledWith('claude', 'sess-1', 40, '/t/path')
    expect(runtimeEnvironmentsCall).not.toHaveBeenCalled()
  })

  it('returns the runtime adapter for an owner on the desktop client', async () => {
    markRuntimeEnvironmentCompatible(ENV)
    runtimeEnvironmentsCall.mockResolvedValue(okEnvelope({ messages: [] }))
    const transport = getNativeChatSessionTransport(ENV)

    await transport.readSession('claude', 'sess-1', 40, '/t/path')

    expect(runtimeEnvironmentsCall).toHaveBeenCalledWith({
      selector: ENV,
      method: 'nativeChat.readSession',
      params: {
        agent: 'claude',
        sessionId: 'sess-1',
        limit: 40,
        transcriptPath: '/t/path',
        capabilities: { transcriptSourceOrder: 1 }
      },
      timeoutMs: 15_000,
      expectedEnvironmentPairingRevision: 1,
      expectedEnvironmentRuntimeId: undefined
    })
    expect(nativeChatReadSession).not.toHaveBeenCalled()
  })

  it('validates lifecycle metadata on runtime read responses', async () => {
    markRuntimeEnvironmentCompatible(ENV)
    const lifecycle = { state: 'completed', turnId: 'turn-1', timestamp: 42 } as const
    runtimeEnvironmentsCall
      .mockResolvedValueOnce(okEnvelope({ messages: [message('valid')], lifecycle }))
      .mockResolvedValueOnce(
        okEnvelope({
          messages: [message('invalid')],
          lifecycle: { state: 'completed', turnId: '', timestamp: undefined }
        })
      )
    const transport = getNativeChatSessionTransport(ENV)

    await expect(transport.readSession('claude', 'sess-1')).resolves.toEqual({
      messages: [message('valid')],
      lifecycle
    })
    await expect(transport.readSession('claude', 'sess-1')).resolves.toEqual({
      messages: [message('invalid')]
    })
  })

  it('accepts interrupted lifecycle metadata from a remote runtime', async () => {
    markRuntimeEnvironmentCompatible(ENV)
    const lifecycle = { state: 'interrupted', turnId: 'turn-2', timestamp: 43 } as const
    runtimeEnvironmentsCall.mockResolvedValueOnce(
      okEnvelope({ messages: [message('interrupted')], lifecycle })
    )
    const transport = getNativeChatSessionTransport(ENV)

    await expect(transport.readSession('codex', 'sess-1')).resolves.toEqual({
      messages: [message('interrupted')],
      lifecycle
    })
  })

  it('keeps lifecycle metadata whose timestamp is omitted, normalizing it to null', async () => {
    markRuntimeEnvironmentCompatible(ENV)
    runtimeEnvironmentsCall.mockResolvedValueOnce(
      okEnvelope({
        messages: [message('no-ts')],
        lifecycle: { state: 'completed', turnId: 'turn-3' }
      })
    )
    const transport = getNativeChatSessionTransport(ENV)

    await expect(transport.readSession('claude', 'sess-1')).resolves.toEqual({
      messages: [message('no-ts')],
      lifecycle: { state: 'completed', turnId: 'turn-3', timestamp: null }
    })
  })

  it('captures the browser owner in its web adapter instead of the desktop bridge', async () => {
    ;(window as unknown as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__ = true
    nativeChatReadSession.mockResolvedValue({ messages: [] })
    const transport = getNativeChatSessionTransport(ENV)

    await transport.readSession('claude', 'sess-1', 40, undefined)

    expect(web.create).toHaveBeenCalledWith({ environment: { id: ENV } })
    expect(web.read).toHaveBeenCalledWith('claude', 'sess-1', 40, undefined)
    expect(nativeChatReadSession).not.toHaveBeenCalled()
    expect(runtimeEnvironmentsCall).not.toHaveBeenCalled()
  })
})

describe('runtime readSession error mapping', () => {
  it('maps a method_not_found rejection to the too-old copy (R4)', async () => {
    markRuntimeEnvironmentCompatible(ENV)
    runtimeEnvironmentsCall.mockResolvedValue({
      ok: false,
      error: { code: 'method_not_found', message: 'no such method' }
    })
    const transport = getNativeChatSessionTransport(ENV)

    const result = await transport.readSession('claude', 'sess-1', 40, undefined)

    expect(result).toEqual({ error: expect.stringContaining('too old') })
  })

  it('maps error classes precisely (KTD-4, not catch-all)', () => {
    const tooOld = expect.stringContaining('too old')
    const generic = "Couldn't read agent chat from the remote runtime."

    expect(
      toRuntimeNativeChatErrorMessage(
        new RuntimeRpcCallError({
          id: 'r-1',
          ok: false,
          error: { code: 'method_not_found', message: 'x' }
        })
      )
    ).toEqual(tooOld)

    const compatBlock = Object.assign(new Error('runtime too old'), {
      code: RUNTIME_COMPAT_BLOCK_CODE
    })
    expect(toRuntimeNativeChatErrorMessage(compatBlock)).toEqual(tooOld)

    expect(toRuntimeNativeChatErrorMessage(new Error('request timed out'))).toBe(generic)
  })
})
